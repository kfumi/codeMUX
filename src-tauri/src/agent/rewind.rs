//! Session rewind: locating the target user turn in native JSONL history and
//! truncating the file back to that turn across Claude, Codex and OpenCode.

use std::path::Path;

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::types::AgentKind;
use crate::db::operations;

use super::claude_history::{find_claude_session_jsonl, should_include_claude_history_event};
use super::codex_history::{codex_interactive_events_dir, find_codex_session_jsonl};
use super::native_jsonl::{sanitize_file_segment, split_jsonl_preserving_newlines};
use super::opencode_history;
use super::session_lifecycle::{
    get_agent_session_id, home_dir, is_imported_session, reject_read_only_session, AgentState,
};
use super::SidecarHandle;
use std::str::FromStr;
use tokio::sync::oneshot;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindSessionResult {
    pub files_changed: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindTarget {
    pub provider_message_id: Option<String>,
    pub source_event_index: Option<usize>,
    pub line_index: Option<usize>,
    pub role: Option<String>,
    pub text_fingerprint: Option<String>,
    pub turn_ordinal: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RewindOutcome {
    pub truncated_to_empty: bool,
}

pub(crate) fn is_claude_visible_user_value(value: &serde_json::Value) -> bool {
    if !should_include_claude_history_event(value) {
        return false;
    }
    value.get("type").and_then(|entry| entry.as_str()) == Some("user")
}

// A turn boundary marks the end of a previous turn when scanning backwards.
// We stop scanning at `result` events and at assistant messages that carry a
// `text` content block (the final reply to the user). Thinking-only and
// tool_use-only assistant messages are mid-turn and must NOT stop the scan —
// Claude Code emits thinking, tool_use, and text as separate assistant lines,
// so only the text line reliably signals "turn finished replying".
pub(crate) fn is_claude_turn_boundary(value: &serde_json::Value) -> bool {
    let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if msg_type == "result" {
        return true;
    }
    if msg_type == "assistant" {
        return value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            })
            .unwrap_or(false);
    }
    false
}

fn is_codex_visible_user_value(value: &serde_json::Value) -> bool {
    let Some(payload) = value.get("payload") else {
        return false;
    };

    if value.get("type").and_then(|entry| entry.as_str()) == Some("response_item") {
        return payload.get("type").and_then(|entry| entry.as_str()) == Some("message")
            && payload.get("role").and_then(|entry| entry.as_str()) == Some("user");
    }

    value.get("type").and_then(|entry| entry.as_str()) == Some("event_msg")
        && payload.get("type").and_then(|entry| entry.as_str()) == Some("user_message")
}

fn is_rewind_user_value(value: &serde_json::Value, agent_kind: AgentKind) -> bool {
    match agent_kind {
        AgentKind::Codex => is_codex_visible_user_value(value),
        AgentKind::ClaudeCode | AgentKind::GeminiCli | AgentKind::Opencode => {
            is_claude_visible_user_value(value)
        }
    }
}

fn extract_provider_message_id(value: &serde_json::Value, agent_kind: AgentKind) -> Option<String> {
    let direct = ["uuid", "id", "message_id", "messageId"]
        .iter()
        .find_map(|key| value.get(key).and_then(|entry| entry.as_str()));
    if direct.is_some() {
        return direct.map(ToString::to_string);
    }

    if matches!(agent_kind, AgentKind::Codex) {
        return value.get("payload").and_then(|payload| {
            ["id", "uuid", "message_id", "messageId"]
                .iter()
                .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()))
                .map(ToString::to_string)
        });
    }

    None
}

fn extract_user_text_for_rewind(value: &serde_json::Value) -> String {
    let Some(message) = value.get("message") else {
        return value
            .get("payload")
            .and_then(|payload| {
                payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .and_then(|entry| entry.as_str())
            })
            .unwrap_or("")
            .to_string();
    };

    let Some(content) = message.get("content") else {
        return String::new();
    };

    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|entry| entry.as_str()) == Some("text") {
                        block.get("text").and_then(|entry| entry.as_str())
                    } else if block.get("type").and_then(|entry| entry.as_str())
                        == Some("input_text")
                    {
                        block.get("text").and_then(|entry| entry.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub(crate) fn normalize_rewind_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn is_targetable_rewind_user_value(
    value: &serde_json::Value,
    agent_kind: AgentKind,
) -> bool {
    if !is_rewind_user_value(value, agent_kind) {
        return false;
    }

    if value
        .get("isMeta")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    let content = value
        .get("message")
        .and_then(|message| message.get("content"));
    if content
        .and_then(|entry| entry.as_array())
        .map(|blocks| {
            blocks.iter().any(|block| {
                block.get("type").and_then(|entry| entry.as_str()) == Some("tool_result")
            })
        })
        .unwrap_or(false)
    {
        return false;
    }

    let text = extract_user_text_for_rewind(value);
    let trimmed = text.trim_start();
    if trimmed.starts_with("Base directory for this skill: ")
        || (trimmed.starts_with("# AGENTS.md instructions for ")
            && trimmed.contains("<INSTRUCTIONS>"))
    {
        return false;
    }

    true
}

fn rewind_target_matches(
    value: &serde_json::Value,
    line_index: usize,
    targetable_ordinal: usize,
    agent_kind: AgentKind,
    target: &RewindTarget,
) -> bool {
    if let Some(role) = target
        .role
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if role != "user" {
            return false;
        }
    }

    if let Some(provider_message_id) = target
        .provider_message_id
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if extract_provider_message_id(value, agent_kind).as_deref() == Some(provider_message_id) {
            return true;
        }
    }

    if target.line_index == Some(line_index) {
        return true;
    }

    if let Some(source_event_index) = target.source_event_index {
        if source_event_index == line_index {
            return true;
        }
    }

    if let Some(turn_ordinal) = target.turn_ordinal {
        if turn_ordinal == targetable_ordinal {
            if let Some(text_fingerprint) = target
                .text_fingerprint
                .as_deref()
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            {
                return normalize_rewind_text(&extract_user_text_for_rewind(value))
                    == normalize_rewind_text(text_fingerprint);
            }
            return true;
        }
    }

    false
}

fn find_rewind_user_line_by_target(
    lines: &[String],
    agent_kind: AgentKind,
    target: &RewindTarget,
) -> Option<usize> {
    let mut targetable_ordinal = 0usize;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if !is_targetable_rewind_user_value(&value, agent_kind) {
            continue;
        }
        targetable_ordinal += 1;
        if rewind_target_matches(&value, index, targetable_ordinal, agent_kind, target) {
            return Some(index);
        }
    }

    None
}

pub(crate) fn resolve_rewind_provider_message_id(
    path: &Path,
    agent_kind: AgentKind,
    target: Option<&RewindTarget>,
) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = if let Some(target) = target {
        find_rewind_user_line_by_target(&lines, agent_kind, target).or_else(|| {
            // Live locators may carry a CodeMUX event_id that is not the Claude
            // JSONL uuid. Retry with turn ordinal + text fingerprint only.
            if target.turn_ordinal.is_none() && target.text_fingerprint.is_none() {
                return None;
            }
            let fingerprint_only = RewindTarget {
                provider_message_id: None,
                source_event_index: None,
                line_index: None,
                role: target.role.clone(),
                text_fingerprint: target.text_fingerprint.clone(),
                turn_ordinal: target.turn_ordinal,
            };
            find_rewind_user_line_by_target(&lines, agent_kind, &fingerprint_only)
        })
    } else {
        find_latest_targetable_rewind_user_line(&lines, agent_kind)
    }?;
    let value: serde_json::Value = serde_json::from_str(lines[user_line_index].trim()).ok()?;
    extract_provider_message_id(&value, agent_kind)
}

fn find_latest_targetable_rewind_user_line(
    lines: &[String],
    agent_kind: AgentKind,
) -> Option<usize> {
    let mut latest_index = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_targetable_rewind_user_value(&value, agent_kind) {
            latest_index = Some(index);
        }
    }
    latest_index
}

fn find_latest_rewind_user_line(lines: &[String], agent_kind: AgentKind) -> Option<usize> {
    // Step 1: find the latest user line (any type: "user" — plain text, meta,
    // command XML echo, or tool_result). All of these belong to the current turn.
    let mut latest_user_index: Option<usize> = None;
    for (index, line) in lines.iter().enumerate().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_rewind_user_value(&value, agent_kind) {
            latest_user_index = Some(index);
            break;
        }
    }
    let latest_user_index = latest_user_index?;

    // For Codex there is no explicit result/text-only assistant boundary marker
    // in the JSONL, so we treat the latest user line as the turn start.
    if !matches!(
        agent_kind,
        AgentKind::ClaudeCode | AgentKind::GeminiCli | AgentKind::Opencode
    ) {
        return Some(latest_user_index);
    }

    // Step 2: scan backwards to find the earliest user line in this turn.
    // We stop at turn boundaries (result events, text-only assistant replies).
    // Assistant messages with tool_use blocks are within-turn (mid-turn tool
    // calls), so we keep scanning past them. All user lines encountered
    // (including meta, XML echo, tool_result) belong to this turn.
    let mut earliest_user_index = latest_user_index;
    for index in (0..latest_user_index).rev() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_claude_turn_boundary(&value) {
            break;
        }
        if is_rewind_user_value(&value, agent_kind) {
            earliest_user_index = index;
        }
    }

    Some(earliest_user_index)
}

#[cfg(test)]
fn rewind_jsonl_before_latest_turn(
    path: &Path,
    agent_kind: AgentKind,
) -> Result<RewindOutcome, String> {
    rewind_jsonl_before_target_turn(path, agent_kind, None)
}

pub(crate) fn rewind_jsonl_before_target_turn(
    path: &Path,
    agent_kind: AgentKind,
    target: Option<RewindTarget>,
) -> Result<RewindOutcome, String> {
    use std::fs;

    let content = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read session history {}: {}", path.display(), err))?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = if let Some(target) = target.as_ref() {
        match find_rewind_user_line_by_target(&lines, agent_kind, target) {
            Some(index) => index,
            None => {
                // A previous rewind (or an interrupted turn that never flushed)
                // can leave the UI holding a locator for a line that is already
                // gone. If JSONL has no rewindable users left, treat that as
                // success instead of failing the next composer retry.
                if find_latest_rewind_user_line(&lines, agent_kind).is_none() {
                    return Ok(RewindOutcome {
                        truncated_to_empty: true,
                    });
                }
                return Err(format!(
                    "Target rewind user message not found in session history {}",
                    path.display()
                ));
            }
        }
    } else {
        match find_latest_rewind_user_line(&lines, agent_kind) {
            Some(index) => index,
            None => {
                return Ok(RewindOutcome {
                    truncated_to_empty: true,
                });
            }
        }
    };

    let next_content = lines[..user_line_index].concat();
    // Atomic write: write to a temp file first, then rename over the original.
    // This prevents corruption if the process crashes mid-write or the sidecar
    // is concurrently appending to the same file.
    let tmp_path = path.with_extension(format!("jsonl.tmp.{}", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, &next_content).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to write temp session history {}: {}",
            tmp_path.display(),
            err
        )
    })?;
    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to rename temp session history to {}: {}",
            path.display(),
            err
        )
    })?;

    Ok(RewindOutcome {
        truncated_to_empty: !lines[..user_line_index].iter().any(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return false;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                return false;
            };
            is_targetable_rewind_user_value(&value, agent_kind)
        }),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RewindMode {
    Conversation,
    Files,
    Both,
}

impl RewindMode {
    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "files" => Ok(Self::Files),
            "both" => Ok(Self::Both),
            other => Err(format!("Unknown rewind mode: {}", other)),
        }
    }

    fn includes_conversation(self) -> bool {
        matches!(self, Self::Conversation | Self::Both)
    }

    fn includes_files(self) -> bool {
        matches!(self, Self::Files | Self::Both)
    }
}

async fn rewind_agent_files_via_sidecar(
    agent_state: &AgentState,
    app_session_id: &str,
    provider_message_id: &str,
) -> Result<Vec<String>, String> {
    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars
            .get(app_session_id)
            .map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("Agent runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_rewind_files_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "rewind_files",
        "sessionId": app_session_id,
        "requestId": request_id,
        "providerMessageId": provider_message_id,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_rewind_files_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send the file rewind command to the sidecar".to_string());
    }

    match tokio::time::timeout(std::time::Duration::from_secs(60), result_receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Agent sidecar stopped before confirming the file rewind".to_string()),
        Err(_) => {
            agent_state
                .session_rewind_files_waiters
                .lock()
                .await
                .remove(&request_id);
            Err("Timed out waiting for the file rewind".to_string())
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rewind_agent_session(
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    app_session_id: String,
    agent_kind: String,
    target: Option<RewindTarget>,
    mode: Option<String>,
) -> Result<RewindSessionResult, String> {
    reject_read_only_session(&state, &app_session_id)?;
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let mode = match mode.as_deref() {
        Some(value) if !value.trim().is_empty() => RewindMode::from_str(value.trim())?,
        _ => RewindMode::Conversation,
    };
    let mut files_changed: Option<usize> = None;
    let Some(agent_session_id) = get_agent_session_id(state.inner(), &app_session_id, agent_kind)?
    else {
        return Err(format!(
            "No agent session mapping found for session_id={}",
            app_session_id
        ));
    };

    if mode.includes_files() {
        if agent_kind != AgentKind::ClaudeCode {
            return Err("This agent does not support rewinding files".to_string());
        }
        let resolved_from_jsonl = home_dir().ok().and_then(|home| {
            find_claude_session_jsonl(&home.join(".claude"), &agent_session_id).and_then(|path| {
                resolve_rewind_provider_message_id(&path, agent_kind, target.as_ref())
            })
        });
        let provider_message_id = resolved_from_jsonl.or_else(|| {
            target
                .as_ref()
                .and_then(|value| value.provider_message_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        match provider_message_id {
            Some(provider_message_id) => {
                match rewind_agent_files_via_sidecar(
                    agent_state.inner(),
                    &app_session_id,
                    &provider_message_id,
                )
                .await
                {
                    Ok(changed_files) => {
                        if changed_files.is_empty() {
                            if mode == RewindMode::Files {
                                return Err("该消息没有可回退的文件变更".to_string());
                            }
                            warn!(
                                target: "agent",
                                "File rewind found no changed files during both-mode rewind for app_session_id={}",
                                app_session_id
                            );
                        }
                        files_changed = Some(changed_files.len());
                    }
                    Err(error) if mode == RewindMode::Both => {
                        warn!(
                            target: "agent",
                            "File rewind failed during both-mode rewind for app_session_id={}; continuing with conversation rewind: {}",
                            app_session_id,
                            error
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
            None if mode == RewindMode::Files => {
                return Err(
                    "File rewind requires the provider message ID of the target".to_string()
                );
            }
            None => {}
        }
    }

    if !mode.includes_conversation() {
        return Ok(RewindSessionResult { files_changed });
    }

    let home = home_dir()?;
    let (rewind_outcome, history_display): (RewindOutcome, String) = if agent_kind
        == AgentKind::Opencode
    {
        let truncated_to_empty =
            opencode_history::rewind_opencode_session(&home, &agent_session_id, target.as_ref())?;
        (
            RewindOutcome { truncated_to_empty },
            agent_session_id.clone(),
        )
    } else {
        let history_path = match agent_kind {
            AgentKind::ClaudeCode => {
                find_claude_session_jsonl(&home.join(".claude"), &agent_session_id)
            }
            AgentKind::Codex => {
                find_codex_session_jsonl(&home.join(".codex").join("sessions"), &agent_session_id)
            }
            AgentKind::GeminiCli => None,
            AgentKind::Opencode => unreachable!(),
        }
        .ok_or_else(|| {
            format!(
                "Session history file not found for session_id={} agent_session_id={}",
                app_session_id, agent_session_id
            )
        })?;

        let outcome = rewind_jsonl_before_target_turn(&history_path, agent_kind, target.clone())?;

        if agent_kind == AgentKind::Codex {
            let interactive_path = codex_interactive_events_dir(&home)
                .join(format!("{}.jsonl", sanitize_file_segment(&app_session_id)));
            if interactive_path.exists() {
                let _ =
                    rewind_jsonl_before_target_turn(&interactive_path, agent_kind, target.clone());
            }
        }

        (outcome, history_path.display().to_string())
    };

    {
        let db = state.db.lock().unwrap();
        operations::clear_session_timeline(&db, &app_session_id)
            .map_err(|err| format!("Failed to clear rewound session timeline: {}", err))?;
    }

    if rewind_outcome.truncated_to_empty && !is_imported_session(&state, &app_session_id)? {
        {
            let db = state.db.lock().unwrap();
            operations::delete_agent_session_mapping(&db, &app_session_id, agent_kind)
                .map_err(|err| format!("Failed to clear rewound agent session mapping: {}", err))?;
        }
        info!(
            target: "agent",
            "Cleared agent session mapping after rewinding first message app_session_id={} agent_kind={}",
            app_session_id,
            agent_kind.as_str()
        );

        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(&app_session_id)
        };
        if let Some(mut handle) = sidecar {
            info!(
                target: "agent",
                "Shutting down sidecar after rewinding first message app_session_id={} agent_kind={}",
                app_session_id,
                agent_kind.as_str()
            );
            handle.shutdown().await;
        }
    } else {
        let cmd = serde_json::json!({
            "type": "reset_session",
            "sessionId": app_session_id,
        });
        let command_sender = {
            let sidecars = agent_state.sidecars.lock().await;
            sidecars
                .get(&app_session_id)
                .map(SidecarHandle::command_sender)
        };
        if let Some(command_sender) = command_sender {
            command_sender
                .send(cmd.to_string())
                .await
                .map_err(|_| "Failed to send command to sidecar".to_string())?;
        }
    }

    info!(
        target: "agent",
        "Rewound agent session app_session_id={} agent_kind={} history_path={}",
        app_session_id,
        agent_kind.as_str(),
        history_display,
    );

    Ok(RewindSessionResult { files_changed })
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_rewind_provider_message_id, rewind_jsonl_before_latest_turn,
        rewind_jsonl_before_target_turn, RewindTarget,
    };
    use crate::config::types::AgentKind;

    #[test]
    fn rewinds_claude_jsonl_before_latest_visible_user_turn() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n",
                "{\"type\":\"result\",\"subtype\":\"success\"}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_jsonl_before_latest_user_message_but_keeps_session_meta() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session-1\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::Codex).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session-1\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_command_turn_removes_meta_and_xml_echo_together() {
        // When a command turn contains multiple user lines (the plain-text
        // command, the isMeta expansion, and the <command-message> XML echo),
        // all of them belong to the same turn and must be removed together.
        // The previous turn's content must be preserved.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-cmd-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"/init\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"expanded init prompt\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-message>init</command-message><command-name>/init</command-name><command-args></command-args>\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"init answer\"}]}}\n",
                "{\"type\":\"result\",\"subtype\":\"success\"}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_keeps_tool_result_within_previous_turn() {
        // A tool_result line has type "user" but belongs to the previous turn.
        // When the latest user line is a plain-text message from a later turn,
        // the earlier tool_result (and its surrounding assistant tool_use and
        // text-only reply) must all be preserved as part of that earlier turn.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-tool-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The whole first turn (user, tool_use, tool_result, assistant reply)
        // is kept; only the second turn is removed.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_drops_whole_turn_when_tool_result_is_latest_user() {
        // When the latest user line is a tool_result (e.g. the turn is still
        // mid-flight), scanning backwards must walk past the assistant tool_use
        // and reach the turn's first user line, removing the whole turn.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-toolresult-latest-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The whole second turn (user, tool_use, tool_result) is removed;
        // only the first turn survives.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_command_turn_walks_past_thinking_assistant() {
        // Real Claude Code JSONL emits thinking, tool_use, and text as separate
        // assistant lines. A command turn looks like:
        //   user (XML echo) → user (isMeta) → assistant (thinking) →
        //   assistant (tool_use) → user (tool_result) → user (isMeta) →
        //   assistant (thinking) → assistant (text = final reply)
        // The thinking-only assistant must NOT be treated as a turn boundary,
        // otherwise the scan stops too early and the command's XML echo / isMeta
        // lines survive in the JSONL — which re-surface as a phantom command
        // message on the next history load.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-thinking-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-message>find-skills</command-message><command-name>/find-skills</command-name><command-args>触发技能</command-args>\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"expanded prompt\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"planning\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Base directory for this skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"reflecting\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"skill answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The entire command turn (XML echo + isMeta + thinking + tool_use +
        // tool_result + isMeta + thinking + text) is removed; only the first
        // plain-text turn survives.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_by_target_uuid_ignores_later_skill_user_lines() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"use skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Base directory for this skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"skill answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: Some(2),
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_target_missing_does_not_truncate_latest_turn() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-target-missing-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let original = concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
        );
        std::fs::write(&path, original).unwrap();

        let error = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("missing".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .expect_err("missing target should not fall back to latest");

        assert!(error.contains("Target rewind user message not found"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_missing_target_on_empty_history_is_already_rewound() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-already-empty-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "").unwrap();

        let outcome = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("already-gone".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .expect("empty history should not fail a stale locator rewind");

        assert!(outcome.truncated_to_empty);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_without_target_on_empty_history_is_already_rewound() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-empty-ordinal-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "{\"type\":\"system\",\"subtype\":\"init\"}\n").unwrap();

        let outcome = rewind_jsonl_before_target_turn(&path, AgentKind::ClaudeCode, None)
            .expect("history with no user turns is already rewound");

        assert!(outcome.truncated_to_empty);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_single_claude_user_reports_empty_history() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-empty-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
        )
        .unwrap();

        let outcome = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u1".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("first".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        assert!(outcome.truncated_to_empty);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_first_claude_tool_turn_after_system_line_reports_empty_user_history() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-first-tool-turn-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n",
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"use skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"}]}}\n"
            ),
        )
        .unwrap();

        let outcome = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u1".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        assert!(outcome.truncated_to_empty);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_jsonl_by_target_payload_id_ignores_tool_outputs() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u1\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u2\",\"content\":[{\"type\":\"input_text\",\"text\":\"use skill\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_skill\",\"name\":\"Skill\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_skill\",\"output\":\"done\"}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::Codex,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: Some(2),
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u1\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_event_msg_user_by_target_payload_id() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-event-msg-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u1\",\"message\":\"first\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"first answer\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u2\",\"message\":\"use skill\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_skill\",\"name\":\"tool_search\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_skill\",\"output\":\"done\"}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::Codex,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u1\",\"message\":\"first\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"first answer\"}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_claude_uuid_from_fingerprint_without_provider_id() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-resolve-uuid-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        let resolved = resolve_rewind_provider_message_id(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: None,
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("first".to_string()),
                turn_ordinal: Some(1),
            }),
        );
        assert_eq!(resolved.as_deref(), Some("u1"));

        let latest = resolve_rewind_provider_message_id(&path, AgentKind::ClaudeCode, None);
        assert_eq!(latest.as_deref(), Some("u2"));

        let stale_locator = resolve_rewind_provider_message_id(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: Some("codemux-event-id".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("second".to_string()),
                turn_ordinal: Some(2),
            }),
        );
        assert_eq!(stale_locator.as_deref(), Some("u2"));

        let _ = std::fs::remove_file(&path);
    }
}
