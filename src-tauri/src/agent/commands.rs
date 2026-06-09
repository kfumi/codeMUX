use std::collections::HashMap;
use std::sync::Arc;
use log::{debug, info, warn};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use super::{SidecarHandle, spawn_sidecar};

/// Helper: read session-id-map.json and return the Claude session ID for the given app session.
fn get_claude_session_id(app_session_id: &str) -> Result<(std::path::PathBuf, String), String> {
    use std::fs;
    use std::path::PathBuf;

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let claude_dir = PathBuf::from(&home).join(".claude");

    let map_file = claude_dir.join("session-id-map.json");
    if !map_file.exists() {
        return Err("session-id-map.json not found".to_string());
    }
    let map_content = fs::read_to_string(&map_file)
        .map_err(|e| format!("Failed to read session-id-map.json: {}", e))?;
    let map: serde_json::Value = serde_json::from_str(&map_content)
        .map_err(|e| format!("Failed to parse session-id-map.json: {}", e))?;

    let claude_session_id = map
        .get(app_session_id)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("No Claude session mapping for {}", app_session_id))?;

    Ok((claude_dir, claude_session_id.to_string()))
}

/// Find the JSONL file for a given Claude session ID across all project directories.
fn find_session_jsonl(claude_dir: &std::path::Path, claude_session_id: &str) -> Option<std::path::PathBuf> {
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

/// Load session events directly from Claude Code's JSONL session file.
///
/// Reads `~/.claude/session-id-map.json` to find the Claude session ID,
/// then locates and parses `~/.claude/projects/{project}/{sessionId}.jsonl`.
/// Returns a JSON array of raw SDK message objects (user/assistant types only).
#[tauri::command]
pub async fn load_claude_session_events(
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    debug!(target: "agent", "Loading Claude session events for app_session_id={}", app_session_id);

    let (claude_dir, claude_session_id) = get_claude_session_id(&app_session_id)?;

    let jsonl_path = find_session_jsonl(&claude_dir, &claude_session_id)
        .ok_or_else(|| format!("JSONL file not found for Claude session {}", claude_session_id))?;

    debug!(target: "agent", "Reading JSONL from {}", jsonl_path.display());

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open JSONL: {}", e))?;
    let reader = BufReader::new(file);

    let mut messages = Vec::new();
    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // Only include user and assistant messages (skip queue-operation, attachment, etc.)
        if msg_type == "user" || msg_type == "assistant" {
            messages.push(val);
        }
    }

    info!(target: "agent", "Loaded {} messages from Claude JSONL for app_session_id={}", messages.len(), app_session_id);
    Ok(messages)
}

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
    info!(
        target: "agent",
        "Starting agent session session_id={} cwd={} model={} has_api_key={} has_base_url={}",
        session_id,
        cwd,
        model.as_deref().unwrap_or("default"),
        api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false),
        base_url.as_ref().map(|url| !url.is_empty()).unwrap_or(false)
    );

    // Check if a sidecar already exists for this session (e.g. after interrupt).
    // If so, reuse it — just update the channel and send the new start command.
    // Only spawn a new sidecar if one doesn't exist.
    let mut needs_new_sidecar = false;
    {
        let sidecars = agent_state.sidecars.lock().await;
        if let Some(handle) = sidecars.get(&session_id) {
            // Reuse existing sidecar — update the channel so the forwarding task
            // sends events to the new frontend channel
            handle.update_channel(channel.clone()).await;
            info!(target: "agent", "Reusing existing sidecar for session_id={}", session_id);
        } else {
            needs_new_sidecar = true;
        }
    }

    if needs_new_sidecar {
        // Spawn a new sidecar for this session
        let (handle, mut rx) = spawn_sidecar(&app, channel).await?;

        // Spawn a dedicated event forwarding task for this session's sidecar.
        // Reads from the sidecar's stdout receiver and forwards to the shared channel.
        let shared_channel = handle.channel.clone();
        let session_id_clone = session_id.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let ch = shared_channel.lock().await;
                let _ = ch.send(event);
            }
            info!(target: "agent", "Sidecar stream closed for session_id={}", session_id_clone);
        });

        // Store the new sidecar
        {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.insert(session_id.clone(), handle);
        }
    }

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
        debug!(target: "agent", "Attaching {} enabled MCP server(s) to session_id={}", mcp_servers.len(), session_id);
        let mcp_config = crate::mcp::adapters::claude::to_sdk_config(&mcp_servers);
        if !mcp_config.as_object().map_or(true, |o| o.is_empty()) {
            cmd["mcpServers"] = mcp_config;
        }

        // Use cached MCP instructions from the startup probe.
        // This avoids re-probing (spawning+killing) every MCP server on each session start.
        // If the startup probe hasn't finished yet, instructions will be empty —
        // the model can still use WaitForMcpServers as a fallback.
        let cached_instructions = {
            let cache = state.mcp_instructions.lock().unwrap();
            cache.clone()
        };
        let instructions: serde_json::Map<String, serde_json::Value> = cached_instructions
            .into_iter()
            .filter_map(|(name, instr)| {
                // Only include instructions for servers that are in the current config
                if mcp_servers.iter().any(|s| s.name == name) && !instr.is_empty() {
                    Some((name, serde_json::Value::String(instr)))
                } else {
                    None
                }
            })
            .collect();
        if !instructions.is_empty() {
            info!(target: "agent", "Using cached MCP instructions for {} server(s) in session_id={}", instructions.len(), session_id);
            cmd["mcpServerInstructions"] = serde_json::Value::Object(instructions);
        }
    }

    // 读取启用的 skills
    let enabled_skills = {
        let db = state.db.lock().unwrap();
        crate::skills::db::get_enabled_skill_names(&db).unwrap_or_default()
    };

    if !enabled_skills.is_empty() {
        debug!(target: "agent", "Attaching {} enabled skill(s) to session_id={}", enabled_skills.len(), session_id);
        cmd["skills"] = serde_json::json!(enabled_skills);
    }

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
        info!(target: "agent", "Agent start command sent for session_id={}", session_id);
    } else {
        warn!(target: "agent", "Failed to locate sidecar after spawn for session_id={}", session_id);
    }

    Ok(())
}

/// Interrupt the currently running agent query for a specific session.
///
/// Unlike before, the sidecar handle is kept in the map so the process can be
/// reused for subsequent queries without re-spawning. The sidecar itself handles
/// the interrupt by aborting its AbortController and returning to idle state.
#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    info!(target: "agent", "Interrupt requested for session_id={}", session_id);
    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        let _ = handle.send_command(r#"{"type":"interrupt"}"#).await;
        info!(target: "agent", "Interrupt command sent, sidecar kept alive for session_id={}", session_id);
    } else {
        debug!(target: "agent", "Interrupt skipped; no active sidecar for session_id={}", session_id);
    }
    Ok(())
}

/// Shutdown a specific session's sidecar process.
#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    info!(target: "agent", "Shutdown requested for session_id={}", session_id);
    let mut sidecars = agent_state.sidecars.lock().await;
    if let Some(mut handle) = sidecars.remove(&session_id) {
        handle.shutdown().await;
    } else {
        debug!(target: "agent", "Shutdown skipped; no active sidecar for session_id={}", session_id);
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
    info!(target: "agent", "Sending tool response for session_id={} tool_use_id={}", session_id, tool_use_id);
    let cmd = serde_json::json!({
        "type": "tool_response",
        "toolUseId": tool_use_id,
        "response": response,
    });

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
    } else {
        warn!(target: "agent", "Tool response skipped because no sidecar was found for session_id={} tool_use_id={}", session_id, tool_use_id);
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
    info!(target: "agent", "Reset requested for session_id={}", session_id);
    let cmd = serde_json::json!({
        "type": "reset_session",
        "sessionId": session_id,
    });

    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(&session_id) {
        handle.send_command(&cmd.to_string()).await?;
    } else {
        debug!(target: "agent", "Reset skipped; no active sidecar for session_id={}", session_id);
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
        None => {
            debug!(target: "agent", "No Claude session mapping found for session_id={}", app_session_id);
            return Ok(vec![]);
        }
    };

    info!(
        target: "agent",
        "Deleting Claude session files for app_session_id={} claude_session_id={}",
        app_session_id,
        claude_session_id
    );

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

    info!(
        target: "agent",
        "Deleted {} Claude session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}
