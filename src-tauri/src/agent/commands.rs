use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use super::{SidecarHandle, spawn_sidecar};

/// Managed state for the agent sidecar.
/// Each session gets its own sidecar process, enabling concurrent execution.
pub struct AgentState {
    pub sidecars: Arc<Mutex<HashMap<String, SidecarHandle>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecars: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Start a new agent session. Spawns a dedicated sidecar for this session,
/// sends the prompt, and streams SDKMessage JSON events back through the channel.
#[tauri::command]
pub async fn start_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    // If this session already has a sidecar, shut it down first
    {
        let mut sidecars = agent_state.sidecars.lock().await;
        if let Some(mut old_handle) = sidecars.remove(&session_id) {
            old_handle.shutdown().await;
        }
    }

    // Spawn a new sidecar for this session
    let (handle, mut rx) = spawn_sidecar(&app).await?;

    // Store the new sidecar
    {
        let mut sidecars = agent_state.sidecars.lock().await;
        sidecars.insert(session_id.clone(), handle);
    }

    // Spawn a dedicated event forwarding task for this session's sidecar
    let session_id_clone = session_id.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = channel.send(event);
        }
        // Sidecar stdout closed — the process likely exited.
        // Remove from sidecar map if still present.
        // (We can't access agent_state here, so cleanup happens on next start/shutdown)
        eprintln!("[agent] Sidecar for session {} exited", session_id_clone);
    });

    // 读取启用的 MCP servers
    let mcp_servers = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_enabled_mcp_servers(&db).unwrap_or_default()
    };

    // Build and send start command
    let resolved_cwd = if cwd == "." {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| cwd.clone())
    } else {
        cwd
    };
    let mut cmd = serde_json::json!({
        "type": "start",
        "prompt": prompt,
        "cwd": resolved_cwd,
        "sessionId": session_id,
    });

    if let Some(key) = api_key {
        cmd["apiKey"] = serde_json::Value::String(key);
    }
    if let Some(url) = base_url {
        cmd["baseUrl"] = serde_json::Value::String(url);
    }
    if let Some(m) = model {
        cmd["model"] = serde_json::Value::String(m);
    }

    if !mcp_servers.is_empty() {
        let mcp_config = crate::mcp::adapters::claude::to_sdk_config(&mcp_servers);
        if !mcp_config.as_object().map_or(true, |o| o.is_empty()) {
            cmd["mcpServers"] = mcp_config;
        }
    }

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
    }

    Ok(())
}

/// Interrupt the currently running agent query for a specific session.
#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let mut sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.remove(&session_id) {
        // Send interrupt first, then shut down
        let _ = handle.send_command(r#"{"type":"interrupt"}"#).await;
        // Note: we intentionally don't call shutdown here — the sidecar will
        // exit after the interrupt. The cleanup happens via the forwarder task.
    }
    Ok(())
}

/// Shutdown a specific session's sidecar process.
#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let mut sidecars = agent_state.sidecars.lock().await;
    if let Some(mut handle) = sidecars.remove(&session_id) {
        handle.shutdown().await;
    }
    Ok(())
}

/// Send a tool response (e.g. AskUserQuestion answer) back to the sidecar
/// for a specific session.
#[tauri::command]
pub async fn send_tool_response(
    agent_state: State<'_, AgentState>,
    session_id: String,
    tool_use_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "tool_response",
        "toolUseId": tool_use_id,
        "response": response,
    });

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
    }

    Ok(())
}

/// Reset the Claude session mapping for a given app session.
/// This clears the captured Claude session ID so the next query starts fresh.
#[tauri::command]
pub async fn reset_agent_session(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "reset_session",
        "sessionId": session_id,
    });

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
    }

    Ok(())
}

/// Delete all Claude Code session files for a given app session.
///
/// Reads `~/.claude/session-id-map.json` to find the Claude session ID,
/// then removes:
/// - `~/.claude/projects/{project}/{claudeSessionId}.jsonl` (conversation log)
/// - `~/.claude/session-env/{claudeSessionId}/` (session environment)
/// - `~/.claude/file-history/{claudeSessionId}/` (file edit history)
/// - `~/.claude/todos/{claudeSessionId}*.json` (task lists)
/// - `~/.claude/debug/{claudeSessionId}.txt` (debug logs)
/// - Matching lines from `~/.claude/history.jsonl` (global input history)
#[tauri::command]
pub async fn delete_claude_session_files(
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;
    use std::path::PathBuf;

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let claude_dir = PathBuf::from(&home).join(".claude");

    // Read session ID mapping
    let map_file = claude_dir.join("session-id-map.json");
    let map_content = fs::read_to_string(&map_file)
        .map_err(|e| format!("Failed to read session-id-map.json: {}", e))?;
    let map: serde_json::Value = serde_json::from_str(&map_content)
        .map_err(|e| format!("Failed to parse session-id-map.json: {}", e))?;

    let claude_session_id = match map.get(&app_session_id).and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Ok(vec![]), // No mapping found, nothing to clean up
    };

    let mut deleted = Vec::new();
    let projects_dir = claude_dir.join("projects");

    // 1. Delete conversation JSONL files across all project directories
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
            }
        }
    }

    // 2. Delete session-env directory
    let session_env = claude_dir.join("session-env").join(&claude_session_id);
    if session_env.exists() {
        let _ = fs::remove_dir_all(&session_env);
        deleted.push(session_env.to_string_lossy().to_string());
    }

    // 3. Delete file-history directory
    let file_history = claude_dir.join("file-history").join(&claude_session_id);
    if file_history.exists() {
        let _ = fs::remove_dir_all(&file_history);
        deleted.push(file_history.to_string_lossy().to_string());
    }

    // 4. Delete matching todo files
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

    // 5. Delete debug log
    let debug_file = claude_dir.join("debug").join(format!("{}.txt", claude_session_id));
    if debug_file.exists() {
        let _ = fs::remove_file(&debug_file);
        deleted.push(debug_file.to_string_lossy().to_string());
    }

    // 6. Filter global history.jsonl
    let history_file = claude_dir.join("history.jsonl");
    if history_file.exists() {
        if let Ok(content) = fs::read_to_string(&history_file) {
            let filtered: String = content
                .lines()
                .filter(|line| {
                    !line.contains(&format!("\"sessionId\":\"{}\"", claude_session_id))
                })
                .collect::<Vec<_>>()
                .join("\n");
            // Only write back if something was actually removed
            if filtered.len() != content.len() {
                let _ = fs::write(&history_file, filtered);
                deleted.push(history_file.to_string_lossy().to_string());
            }
        }
    }

    // 7. Remove the mapping entry itself
    if let serde_json::Value::Object(mut map_obj) = map {
        map_obj.remove(&app_session_id);
        let _ = fs::write(&map_file, serde_json::to_string_pretty(&map_obj).unwrap_or_default());
    }

    Ok(deleted)
}
