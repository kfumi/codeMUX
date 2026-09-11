//! Session forking: staging Claude history up to the target turn and creating
//! child sessions for Claude, Codex and OpenCode runtimes.

use std::path::Path;
use std::sync::Arc;

use tokio::sync::oneshot;

use crate::config::types::AgentKind;
use crate::db::operations;

use super::claude_history::{
    cleanup_claude_session_files_by_id, find_claude_session_jsonl, is_terminal_claude_stop_reason,
};
use super::native_jsonl::split_jsonl_preserving_newlines;
use super::rewind::is_targetable_rewind_user_value;
use super::session_lifecycle::{
    get_agent_session_id, home_dir, reject_read_only_session, AgentState,
};
use super::SidecarHandle;

fn claude_fork_target_matches(
    value: &serde_json::Value,
    fork_event_id: &str,
    fork_provider_message_id: Option<&str>,
) -> bool {
    let target_ids = [Some(fork_event_id), fork_provider_message_id];
    ["provider_message_id", "uuid", "event_id", "id"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(|entry| entry.as_str()))
        .any(|value| target_ids.iter().flatten().any(|target| *target == value))
}

fn is_claude_fork_turn_complete(lines: &[String], assistant_line_index: usize) -> bool {
    let assistant = serde_json::from_str::<serde_json::Value>(&lines[assistant_line_index]).ok();
    if assistant
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(|message| message.get("stop_reason"))
        .and_then(|reason| reason.as_str())
        .is_some_and(is_terminal_claude_stop_reason)
    {
        return true;
    }

    for line in lines.iter().skip(assistant_line_index + 1) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if is_targetable_rewind_user_value(&value, AgentKind::ClaudeCode) {
            break;
        }
        if value.get("type").and_then(|entry| entry.as_str()) == Some("result")
            && value.get("subtype").and_then(|entry| entry.as_str()) == Some("success")
            && !value
                .get("is_error")
                .and_then(|entry| entry.as_bool())
                .unwrap_or(false)
        {
            return true;
        }
    }

    false
}

fn find_claude_fork_end_line(
    lines: &[String],
    fork_event_id: &str,
    fork_provider_message_id: Option<&str>,
) -> Result<usize, String> {
    let assistant_line_index = lines
        .iter()
        .enumerate()
        .find_map(|(index, line)| {
            let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
            if value.get("type").and_then(|entry| entry.as_str()) != Some("assistant")
                || !claude_fork_target_matches(&value, fork_event_id, fork_provider_message_id)
            {
                return None;
            }
            Some(index)
        })
        .ok_or_else(|| {
            "Fork target assistant message was not found in Claude history".to_string()
        })?;

    if !is_claude_fork_turn_complete(lines, assistant_line_index) {
        return Err("Fork target assistant message is not completed".to_string());
    }

    let mut end_line = assistant_line_index;
    for line in lines.iter().skip(assistant_line_index + 1) {
        let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok();
        let Some(value) = value else {
            continue;
        };
        if is_targetable_rewind_user_value(&value, AgentKind::ClaudeCode) {
            break;
        }
        end_line += 1;
        if value.get("type").and_then(|entry| entry.as_str()) == Some("result") {
            break;
        }
    }
    Ok(end_line)
}

fn replace_claude_session_id(value: &mut serde_json::Value, source_id: &str, child_id: &str) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, entry) in object.iter_mut() {
                if matches!(
                    key.as_str(),
                    "sessionId" | "session_id" | "agent_session_id"
                ) && entry.as_str() == Some(source_id)
                {
                    *entry = serde_json::Value::String(child_id.to_string());
                } else {
                    replace_claude_session_id(entry, source_id, child_id);
                }
            }
        }
        serde_json::Value::Array(entries) => {
            for entry in entries {
                replace_claude_session_id(entry, source_id, child_id);
            }
        }
        _ => {}
    }
}

fn stage_claude_history_fork(
    source_path: &Path,
    source_session_id: &str,
    fork_event_id: &str,
    fork_provider_message_id: Option<&str>,
) -> Result<String, String> {
    use std::fs;

    let content = fs::read_to_string(source_path).map_err(|error| {
        format!(
            "Failed to read Claude session history {}: {}",
            source_path.display(),
            error
        )
    })?;
    let lines = split_jsonl_preserving_newlines(&content);
    let end_line = find_claude_fork_end_line(&lines, fork_event_id, fork_provider_message_id)?;
    let staged_session_id = uuid::Uuid::new_v4().to_string();
    let staged_path = source_path
        .parent()
        .ok_or_else(|| "Claude session history has no parent directory".to_string())?
        .join(format!("{}.jsonl", staged_session_id));
    let mut staged_content = String::new();

    for line in &lines[..=end_line] {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut value = serde_json::from_str::<serde_json::Value>(trimmed)
            .map_err(|error| format!("Invalid JSON in Claude session history: {}", error))?;
        replace_claude_session_id(&mut value, source_session_id, &staged_session_id);
        staged_content
            .push_str(&serde_json::to_string(&value).map_err(|error| {
                format!("Failed to serialize staged Claude history: {}", error)
            })?);
        staged_content.push('\n');
    }

    let temporary_path = source_path
        .parent()
        .ok_or_else(|| "Claude session history has no parent directory".to_string())?
        .join(format!(
            "{}.jsonl.tmp.{}",
            staged_session_id,
            uuid::Uuid::new_v4()
        ));
    if let Err(error) = fs::write(&temporary_path, staged_content)
        .and_then(|_| fs::rename(&temporary_path, &staged_path))
    {
        let _ = fs::remove_file(&temporary_path);
        let _ = fs::remove_file(&staged_path);
        return Err(format!(
            "Failed to create staged Claude fork history: {}",
            error
        ));
    }

    Ok(staged_session_id)
}

/// Copies the staged fork history into the child Claude session JSONL.
///
/// Claude SDK fork only materializes the active branch in the child file; the
/// staged JSONL already contains the truncated history CodeMUX needs for display.
fn install_claude_fork_child_history(
    staged_path: &Path,
    staged_session_id: &str,
    child_session_id: &str,
) -> Result<(), String> {
    use std::fs;

    let parent = staged_path
        .parent()
        .ok_or_else(|| "Claude session history has no parent directory".to_string())?;
    let child_path = parent.join(format!("{}.jsonl", child_session_id));

    let content = fs::read_to_string(staged_path).map_err(|error| {
        format!(
            "Failed to read staged Claude fork history {}: {}",
            staged_path.display(),
            error
        )
    })?;
    let lines = split_jsonl_preserving_newlines(&content);
    let mut child_content = String::new();

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut value = serde_json::from_str::<serde_json::Value>(trimmed)
            .map_err(|error| format!("Invalid JSON in staged Claude fork history: {}", error))?;
        replace_claude_session_id(&mut value, staged_session_id, child_session_id);
        child_content.push_str(&serde_json::to_string(&value).map_err(|error| {
            format!("Failed to serialize child Claude fork history: {}", error)
        })?);
        child_content.push('\n');
    }

    let temporary_path = parent.join(format!(
        "{}.jsonl.tmp.{}",
        child_session_id,
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::write(&temporary_path, child_content)
        .and_then(|_| fs::rename(&temporary_path, &child_path))
    {
        let _ = fs::remove_file(&temporary_path);
        let _ = fs::remove_file(&child_path);
        return Err(format!(
            "Failed to install child Claude fork history: {}",
            error
        ));
    }

    Ok(())
}

pub async fn fork_claude_session_impl(
    state: Arc<crate::AppState>,
    agent_state: Arc<AgentState>,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    reject_read_only_session(&state, &session_id)?;

    let source = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };
    if source.agent_kind != AgentKind::ClaudeCode {
        return Err("Only Claude sessions support Fork in this version".to_string());
    }
    if source.origin == "imported" || source.is_read_only {
        return Err("Imported or read-only sessions cannot be forked".to_string());
    }
    if fork_event_id.trim().is_empty() {
        return Err("Fork target is missing the assistant message ID".to_string());
    }
    let source_agent_session_id = get_agent_session_id(&state, &session_id, AgentKind::ClaudeCode)?
        .ok_or_else(|| "No Claude session mapping found for the source session".to_string())?;
    let source_history_path =
        find_claude_session_jsonl(&home_dir()?.join(".claude"), &source_agent_session_id)
            .ok_or_else(|| "Claude session history file was not found".to_string())?;
    let staged_session_id = stage_claude_history_fork(
        &source_history_path,
        &source_agent_session_id,
        &fork_event_id,
        fork_provider_message_id.as_deref(),
    )?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        let _ = cleanup_claude_session_files_by_id(&staged_session_id);
        return Err("Claude runtime is not active; reopen the session and try again".to_string());
    };

    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_fork_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "fork_session",
        "sessionId": session_id,
        "requestId": request_id,
        "sourceAgentSessionId": staged_session_id,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_fork_waiters
            .lock()
            .await
            .remove(&request_id);
        let _ = cleanup_claude_session_files_by_id(&staged_session_id);
        return Err("Failed to send Claude session fork command to sidecar".to_string());
    }

    let child_result =
        match tokio::time::timeout(std::time::Duration::from_secs(30), result_receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Claude sidecar stopped before confirming session fork".to_string()),
            Err(_) => {
                agent_state
                    .session_fork_waiters
                    .lock()
                    .await
                    .remove(&request_id);
                Err("Timed out waiting for Claude session fork".to_string())
            }
        };
    if child_result.is_err() {
        let _ = cleanup_claude_session_files_by_id(&staged_session_id);
    }
    let child_agent_session_id = child_result?;
    let staged_path = source_history_path
        .parent()
        .ok_or_else(|| "Claude session history has no parent directory".to_string())?
        .join(format!("{}.jsonl", staged_session_id));
    install_claude_fork_child_history(&staged_path, &staged_session_id, &child_agent_session_id)
        .map_err(|error| {
            let _ = cleanup_claude_session_files_by_id(&staged_session_id);
            let _ = cleanup_claude_session_files_by_id(&child_agent_session_id);
            error
        })?;
    let _ = cleanup_claude_session_files_by_id(&staged_session_id);

    let child_title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("分支 · {}", source.title));
    let mut db = state.db.lock().unwrap();
    operations::create_forked_session(
        &mut db,
        &session_id,
        &child_agent_session_id,
        &fork_event_id,
        fork_provider_message_id.as_deref(),
        &child_title,
    )
    .map_err(|error| {
        let _ = cleanup_claude_session_files_by_id(&child_agent_session_id);
        error.to_string()
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn fork_codex_session_impl(
    state: Arc<crate::AppState>,
    agent_state: Arc<AgentState>,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    fork_provider_turn_id: Option<String>,
    fork_provider_turn_ordinal: Option<usize>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    reject_read_only_session(&state, &session_id)?;

    let source = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };
    if source.agent_kind != AgentKind::Codex {
        return Err("Only Codex sessions support the Codex Fork command".to_string());
    }
    if source.origin == "imported" || source.is_read_only {
        return Err("Imported or read-only sessions cannot be forked".to_string());
    }
    if fork_event_id.trim().is_empty() {
        return Err("Fork target is missing the assistant message ID".to_string());
    }
    let source_agent_session_id = get_agent_session_id(&state, &session_id, AgentKind::Codex)?
        .ok_or_else(|| "No Codex session mapping found for the source session".to_string())?;

    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("Codex runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_fork_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "fork_session",
        "sessionId": session_id,
        "requestId": request_id,
        "sourceAgentSessionId": source_agent_session_id,
        "sourceProviderTurnId": fork_provider_turn_id,
        "sourceProviderTurnOrdinal": fork_provider_turn_ordinal,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_fork_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send Codex session fork command to sidecar".to_string());
    }

    let child_result =
        match tokio::time::timeout(std::time::Duration::from_secs(30), result_receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex sidecar stopped before confirming session fork".to_string()),
            Err(_) => {
                agent_state
                    .session_fork_waiters
                    .lock()
                    .await
                    .remove(&request_id);
                Err("Timed out waiting for Codex session fork".to_string())
            }
        };
    let child_agent_session_id = child_result?;

    let child_title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("分支 · {}", source.title));
    let mut db = state.db.lock().unwrap();
    operations::create_forked_session(
        &mut db,
        &session_id,
        &child_agent_session_id,
        &fork_event_id,
        fork_provider_message_id.as_deref(),
        &child_title,
    )
    .map_err(|error| error.to_string())
}

pub async fn fork_opencode_session_impl(
    state: Arc<crate::AppState>,
    agent_state: Arc<AgentState>,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    reject_read_only_session(&state, &session_id)?;

    let source = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };
    if source.agent_kind != AgentKind::Opencode {
        return Err("Only OpenCode sessions support the OpenCode Fork command".to_string());
    }
    if source.origin == "imported" || source.is_read_only {
        return Err("Imported or read-only sessions cannot be forked".to_string());
    }
    if fork_event_id.trim().is_empty() {
        return Err("Fork target is missing the assistant message ID".to_string());
    }
    if fork_provider_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(
            "OpenCode Fork target is missing its provider message ID; reopen the session and try again"
                .to_string(),
        );
    }
    let source_agent_session_id = get_agent_session_id(&state, &session_id, AgentKind::Opencode)?
        .ok_or_else(|| {
        "No OpenCode session mapping found for the source session".to_string()
    })?;

    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("OpenCode runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_fork_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "fork_session",
        "sessionId": session_id,
        "requestId": request_id,
        "sourceAgentSessionId": source_agent_session_id,
        "sourceProviderMessageId": fork_provider_message_id,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_fork_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send OpenCode session fork command to sidecar".to_string());
    }

    let child_result =
        match tokio::time::timeout(std::time::Duration::from_secs(30), result_receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("OpenCode sidecar stopped before confirming session fork".to_string())
            }
            Err(_) => {
                agent_state
                    .session_fork_waiters
                    .lock()
                    .await
                    .remove(&request_id);
                Err("Timed out waiting for OpenCode session fork".to_string())
            }
        };
    let child_agent_session_id = child_result?;

    let child_title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("分支 · {}", source.title));
    let mut db = state.db.lock().unwrap();
    operations::create_forked_session(
        &mut db,
        &session_id,
        &child_agent_session_id,
        &fork_event_id,
        fork_provider_message_id.as_deref(),
        &child_title,
    )
    .map_err(|error| error.to_string())
}

/// pi Fork：整卷拷贝原生会话文件（sidecar 侧完成），新 mapping 指向副本。
/// 与 OpenCode 的「fork 到指定消息」不同，pi 无树导航接入，fork 语义为
/// 整会话副本；fork_event_id / provider message id 仅透传记录。
pub async fn fork_pi_session_impl(
    state: Arc<crate::AppState>,
    agent_state: Arc<AgentState>,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    reject_read_only_session(&state, &session_id)?;

    let source = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };
    if source.agent_kind != AgentKind::Pi {
        return Err("Only pi sessions support the pi Fork command".to_string());
    }
    if source.origin == "imported" || source.is_read_only {
        return Err("Imported or read-only sessions cannot be forked".to_string());
    }
    let source_agent_session_id = get_agent_session_id(&state, &session_id, AgentKind::Pi)?
        .ok_or_else(|| "No pi session mapping found for the source session".to_string())?;

    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("pi runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_fork_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "fork_session",
        "sessionId": session_id,
        "requestId": request_id,
        "sourceAgentSessionId": source_agent_session_id,
        "sourceProviderMessageId": fork_provider_message_id,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_fork_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send pi session fork command to sidecar".to_string());
    }

    let child_result =
        match tokio::time::timeout(std::time::Duration::from_secs(30), result_receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("pi sidecar stopped before confirming session fork".to_string()),
            Err(_) => {
                agent_state
                    .session_fork_waiters
                    .lock()
                    .await
                    .remove(&request_id);
                Err("Timed out waiting for pi session fork".to_string())
            }
        };
    let child_agent_session_id = child_result?;

    let child_title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("分支 · {}", source.title));
    let mut db = state.db.lock().unwrap();
    operations::create_forked_session(
        &mut db,
        &session_id,
        &child_agent_session_id,
        &fork_event_id,
        fork_provider_message_id.as_deref(),
        &child_title,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{install_claude_fork_child_history, stage_claude_history_fork};

    #[test]
    fn installs_staged_claude_history_into_child_session_file() {
        use std::fs;

        let base =
            std::env::temp_dir().join(format!("codemux-claude-fork-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source-session.jsonl");
        fs::write(
            &source_path,
            concat!(
                "{\"sessionId\":\"source-session\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"assistant\",\"uuid\":\"assistant-1\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"later\"}}\n"
            ),
        )
        .unwrap();

        let staged_id =
            stage_claude_history_fork(&source_path, "source-session", "assistant-1", None).unwrap();
        let staged_path = base.join(format!("{}.jsonl", staged_id));
        let child_id = "child-session".to_string();

        install_claude_fork_child_history(&staged_path, &staged_id, &child_id).unwrap();

        let child_path = base.join(format!("{}.jsonl", child_id));
        let child_lines = fs::read_to_string(&child_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(child_lines.len(), 3);
        assert!(child_lines.iter().all(|line| line
            .get("sessionId")
            .and_then(|value| value.as_str())
            == Some(child_id.as_str())));
        assert_eq!(
            child_lines[1].get("uuid").and_then(|value| value.as_str()),
            Some("assistant-1")
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stages_claude_history_through_the_selected_completed_turn() {
        use std::fs;

        let base =
            std::env::temp_dir().join(format!("codemux-claude-fork-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source-session.jsonl");
        fs::write(
            &source_path,
            concat!(
                "{\"sessionId\":\"source-session\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"assistant\",\"uuid\":\"assistant-1\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n",
                "{\"sessionId\":\"source-session\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"later\"}}\n"
            ),
        )
        .unwrap();

        let staged_id =
            stage_claude_history_fork(&source_path, "source-session", "assistant-1", None).unwrap();
        let staged_path = base.join(format!("{}.jsonl", staged_id));
        let staged_lines = fs::read_to_string(&staged_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(staged_lines.len(), 3);
        assert!(staged_lines.iter().all(|line| line
            .get("sessionId")
            .and_then(|value| value.as_str())
            == Some(staged_id.as_str())));
        assert_eq!(
            staged_lines[1].get("uuid").and_then(|value| value.as_str()),
            Some("assistant-1")
        );
        assert!(!staged_path.to_string_lossy().contains("source-session"));

        let _ = fs::remove_dir_all(&base);
    }
}

pub async fn fork_claude_session_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    fork_claude_session_impl(
        daemon.app.clone(),
        daemon.agent.clone(),
        session_id,
        fork_event_id,
        fork_provider_message_id,
        title,
    )
    .await
}

pub async fn fork_codex_session_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    fork_provider_turn_id: Option<String>,
    fork_provider_turn_ordinal: Option<usize>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    fork_codex_session_impl(
        daemon.app.clone(),
        daemon.agent.clone(),
        session_id,
        fork_event_id,
        fork_provider_message_id,
        fork_provider_turn_id,
        fork_provider_turn_ordinal,
        title,
    )
    .await
}

pub async fn fork_opencode_session_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    fork_opencode_session_impl(
        daemon.app.clone(),
        daemon.agent.clone(),
        session_id,
        fork_event_id,
        fork_provider_message_id,
        title,
    )
    .await
}

pub async fn fork_pi_session_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    title: Option<String>,
) -> Result<operations::Session, String> {
    fork_pi_session_impl(
        daemon.app.clone(),
        daemon.agent.clone(),
        session_id,
        fork_event_id,
        fork_provider_message_id,
        title,
    )
    .await
}
