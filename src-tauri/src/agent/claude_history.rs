//! Claude native history: JSONL location, visibility rules, loading and
//! deletion of `~/.claude` session artifacts.

use std::path::{Path, PathBuf};

use log::{debug, info};
use tauri::State;

use crate::config::types::AgentKind;

use super::history_events::normalize_history_events;
use super::session_lifecycle::{get_agent_session_id, home_dir};

pub(crate) fn find_claude_session_jsonl(
    claude_dir: &Path,
    claude_session_id: &str,
) -> Option<PathBuf> {
    use std::fs;

    let projects_dir = claude_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    for entry in fs::read_dir(&projects_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let jsonl = entry.path().join(format!("{}.jsonl", claude_session_id));
        if jsonl.exists() {
            return Some(jsonl);
        }
    }
    None
}

pub(crate) fn should_include_claude_history_event(val: &serde_json::Value) -> bool {
    if val
        .get("isSidechain")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    if val
        .get("isMeta")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    let msg_type = val
        .get("type")
        .and_then(|entry| entry.as_str())
        .unwrap_or("");
    if msg_type == "user" || msg_type == "assistant" || msg_type == "result" {
        return true;
    }

    msg_type == "system"
        && val.get("subtype").and_then(|entry| entry.as_str()) == Some("compact_boundary")
}

pub(crate) fn is_terminal_claude_stop_reason(reason: &str) -> bool {
    matches!(
        reason,
        "end_turn" | "stop_sequence" | "max_tokens" | "refusal"
    )
}

#[tauri::command]
pub async fn load_claude_session_events(
    state: State<'_, std::sync::Arc<crate::AppState>>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    load_claude_session_events_impl(state.inner(), app_session_id).await
}

pub(crate) async fn load_claude_session_events_impl(
    state: &crate::AppState,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    debug!(target: "agent", "Loading Claude session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();

    let Some(claude_session_id) =
        get_agent_session_id(state, &app_session_id, AgentKind::ClaudeCode)?
    else {
        info!(target: "agent", "No Claude mapping found for app_session_id={}", app_session_id);
        return Ok(messages);
    };

    let claude_dir = home_dir()?.join(".claude");
    let Some(jsonl_path) = find_claude_session_jsonl(&claude_dir, &claude_session_id) else {
        info!(
            target: "agent",
            "Claude JSONL not found for app_session_id={} claude_session_id={}",
            app_session_id,
            claude_session_id
        );
        return Ok(messages);
    };

    debug!(target: "agent", "Reading JSONL from {}", jsonl_path.display());

    let normalize_session_id = app_session_id.clone();
    let normalized =
        tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
            use std::fs;
            use std::io::{BufRead, BufReader};

            let file =
                fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
            let reader = BufReader::new(file);

            for (line_index, line_result) in reader.lines().enumerate() {
                let line = match line_result {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let mut val: serde_json::Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if should_include_claude_history_event(&val) {
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("__lineIndex".to_string(), serde_json::json!(line_index));
                    }
                    messages.push(val);
                }
            }

            Ok(normalize_history_events(messages, &normalize_session_id))
        })
        .await
        .map_err(|error| format!("Failed to join Claude history loader: {}", error))??;
    info!(target: "agent", "Loaded {} CodeMUX events from Claude JSONL for app_session_id={}", normalized.len(), app_session_id);
    Ok(normalized)
}

#[tauri::command]
pub async fn delete_claude_session_files(
    state: State<'_, std::sync::Arc<crate::AppState>>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    delete_claude_session_files_for_companion(state.inner(), app_session_id).await
}

pub async fn delete_claude_session_files_for_companion(
    state: &crate::AppState,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;
    let claude_dir = home_dir()?.join(".claude");

    let Some(claude_session_id) =
        get_agent_session_id(state, &app_session_id, AgentKind::ClaudeCode)?
    else {
        debug!(target: "agent", "No Claude session mapping found for session_id={}", app_session_id);
        return Ok(vec![]);
    };

    info!(
        target: "agent",
        "Deleting Claude session files for app_session_id={} claude_session_id={}",
        app_session_id,
        claude_session_id
    );

    let mut deleted = Vec::new();
    let projects_dir = claude_dir.join("projects");

    if projects_dir.exists() {
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let jsonl = entry.path().join(format!("{}.jsonl", claude_session_id));
                if jsonl.exists() {
                    let _ = fs::remove_file(&jsonl);
                    deleted.push(jsonl.to_string_lossy().to_string());
                }
                // 删除会话子目录（含 subagents 等子智能体记录）
                let session_subdir = entry.path().join(&claude_session_id);
                if session_subdir.exists() {
                    let _ = fs::remove_dir_all(&session_subdir);
                    deleted.push(session_subdir.to_string_lossy().to_string());
                }
            }
        }
    }

    let session_env = claude_dir.join("session-env").join(&claude_session_id);
    if session_env.exists() {
        let _ = fs::remove_dir_all(&session_env);
        deleted.push(session_env.to_string_lossy().to_string());
    }

    let file_history = claude_dir.join("file-history").join(&claude_session_id);
    if file_history.exists() {
        let _ = fs::remove_dir_all(&file_history);
        deleted.push(file_history.to_string_lossy().to_string());
    }

    let todos_dir = claude_dir.join("todos");
    if todos_dir.exists() {
        if let Ok(entries) = fs::read_dir(&todos_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&claude_session_id) {
                    let _ = fs::remove_file(entry.path());
                    deleted.push(entry.path().to_string_lossy().to_string());
                }
            }
        }
    }

    let debug_file = claude_dir
        .join("debug")
        .join(format!("{}.txt", claude_session_id));
    if debug_file.exists() {
        let _ = fs::remove_file(&debug_file);
        deleted.push(debug_file.to_string_lossy().to_string());
    }

    let history_file = claude_dir.join("history.jsonl");
    if history_file.exists() {
        if let Ok(content) = fs::read_to_string(&history_file) {
            let filtered: String = content
                .lines()
                .filter(|line| !line.contains(&format!("\"sessionId\":\"{}\"", claude_session_id)))
                .collect::<Vec<_>>()
                .join("\n");
            if filtered.len() != content.len() {
                let _ = fs::write(&history_file, filtered);
                deleted.push(history_file.to_string_lossy().to_string());
            }
        }
    }

    info!(
        target: "agent",
        "Deleted {} Claude session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

pub(crate) fn cleanup_claude_session_files_by_id(claude_session_id: &str) -> Result<(), String> {
    crate::agent::native_cleanup::cleanup_claude_native_session(&home_dir()?, claude_session_id)
}

#[cfg(test)]
mod tests {
    use super::should_include_claude_history_event;

    #[test]
    fn claude_history_includes_compact_boundary_events() {
        let compact = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
            "compactMetadata": {
                "trigger": "manual",
                "preTokens": 40956,
                "postTokens": 2876
            }
        });

        assert!(should_include_claude_history_event(&compact));
    }

    #[test]
    fn claude_history_excludes_non_visible_system_and_sidechain_events() {
        let status = serde_json::json!({
            "type": "system",
            "subtype": "status",
            "status": "compacting"
        });
        let sidechain_user = serde_json::json!({
            "type": "user",
            "isSidechain": true,
            "message": { "role": "user", "content": "subagent" }
        });

        assert!(!should_include_claude_history_event(&status));
        assert!(!should_include_claude_history_event(&sidechain_user));
    }

    #[test]
    fn claude_history_excludes_meta_user_events() {
        let meta_user = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "role": "user", "content": "Continue from where you left off." }
        });

        assert!(!should_include_claude_history_event(&meta_user));
    }
}
