use std::collections::HashMap;
use std::sync::Arc;

use log::{debug, info, warn};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use super::{spawn_sidecar, SidecarHandle};

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

fn find_session_jsonl(
    claude_dir: &std::path::Path,
    claude_session_id: &str,
) -> Option<std::path::PathBuf> {
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

#[tauri::command]
pub async fn load_claude_session_events(
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    debug!(target: "agent", "Loading Claude session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();

    if let Ok((claude_dir, claude_session_id)) = get_claude_session_id(&app_session_id) {
        if let Some(jsonl_path) = find_session_jsonl(&claude_dir, &claude_session_id) {
            debug!(target: "agent", "Reading JSONL from {}", jsonl_path.display());

            let file = fs::File::open(&jsonl_path)
                .map_err(|e| format!("Failed to open JSONL: {}", e))?;
            let reader = BufReader::new(file);

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
                if msg_type == "user" || msg_type == "assistant" || msg_type == "result" {
                    messages.push(val);
                }
            }
        }
    }

    info!(target: "agent", "Loaded {} messages from Claude JSONL for app_session_id={}", messages.len(), app_session_id);
    Ok(messages)
}

pub struct AgentState {
    pub sidecars: Arc<Mutex<HashMap<String, SidecarHandle>>>,
    pub session_startup_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Port of the running codex compat proxy, if any.
    pub proxy_port: Arc<Mutex<Option<u16>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecars: Arc::new(Mutex::new(HashMap::new())),
            session_startup_locks: Arc::new(Mutex::new(HashMap::new())),
            proxy_port: Arc::new(Mutex::new(None)),
        }
    }
}

async fn ensure_sidecar_for_session(
    app: AppHandle,
    agent_state: &State<'_, AgentState>,
    session_id: &str,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let session_lock = {
        let mut locks = agent_state.session_startup_locks.lock().await;
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _startup_guard = session_lock.lock().await;

    {
        let sidecars = agent_state.sidecars.lock().await;
        if let Some(handle) = sidecars.get(session_id) {
            handle.update_channel(channel.clone()).await;
            info!(target: "agent", "Reusing existing sidecar for session_id={}", session_id);
            return Ok(());
        }
    }

    let (handle, mut rx) = spawn_sidecar(&app, channel).await?;
    let shared_channel = handle.channel.clone();
    let session_id_clone = session_id.to_string();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let ch = shared_channel.lock().await;
            let _ = ch.send(event);
        }
        info!(target: "agent", "Sidecar stream closed for session_id={}", session_id_clone);
    });

    let mut sidecars = agent_state.sidecars.lock().await;
    sidecars.insert(session_id.to_string(), handle);

    Ok(())
}

fn build_ensure_session_command(
    state: &crate::AppState,
    session_id: &str,
    agent_kind: &str,
    cwd: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> serde_json::Value {
    let mcp_servers = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_enabled_mcp_servers(&db).unwrap_or_default()
    };

    let resolved_cwd = if cwd == "." {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| cwd.clone())
    } else {
        cwd
    };
    let mut cmd = serde_json::json!({
        "type": "ensure_session",
        "agentKind": agent_kind,
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

        let cached_instructions = {
            let cache = state.mcp_instructions.lock().unwrap();
            cache.clone()
        };
        let instructions: serde_json::Map<String, serde_json::Value> = cached_instructions
            .into_iter()
            .filter_map(|(name, instr)| {
                if mcp_servers.iter().any(|s| s.name == name) && !instr.is_empty() {
                    Some((name, serde_json::Value::String(instr)))
                } else {
                    None
                }
            })
            .collect();
        if !instructions.is_empty() {
            cmd["mcpServerInstructions"] = serde_json::Value::Object(instructions);
        }
    }

    let enabled_skills = {
        let db = state.db.lock().unwrap();
        crate::skills::db::get_enabled_skill_names(&db).unwrap_or_default()
    };
    if !enabled_skills.is_empty() {
        cmd["skills"] = serde_json::json!(enabled_skills);
    }

    cmd
}

async fn send_command_to_session(
    agent_state: &State<'_, AgentState>,
    session_id: &str,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let sidecars = agent_state.sidecars.lock().await;
    if let Some(handle) = sidecars.get(session_id) {
        handle.send_command(&cmd.to_string()).await
    } else {
        Err(format!("No sidecar found for session_id={}", session_id))
    }
}

#[tauri::command]
pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    info!(
        target: "agent",
        "Ensuring agent session session_id={} cwd={} model={} has_api_key={} has_base_url={}",
        session_id,
        cwd,
        model.as_deref().unwrap_or("default"),
        api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false),
        base_url.as_ref().map(|url| !url.is_empty()).unwrap_or(false)
    );

    let agent_kind = {
        let db = state.db.lock().unwrap();
        crate::agent_runtime::factory::session_runtime_kind_name(&db, &session_id)
            .unwrap_or_else(|_| "claude_code".to_string())
    };

    ensure_sidecar_for_session(app, &agent_state, &session_id, channel).await?;

    // Get stderr Arc before sending command (for proxy port parsing)
    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

    let cmd = build_ensure_session_command(&state, &session_id, &agent_kind, cwd, api_key, base_url, model);
    send_command_to_session(&agent_state, &session_id, cmd).await?;
    info!(target: "agent", "Agent ensure command sent for session_id={} agent_kind={}", session_id, agent_kind);

    // Parse proxy port from stderr if proxy was auto-started
    if agent_kind == "codex" {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Some(lines) = stderr_lines {
            let captured = lines.lock().await;
            if let Some(port) = parse_proxy_port_from_stderr(&captured) {
                *agent_state.proxy_port.lock().await = Some(port);
                info!(target: "agent", "Auto-detected codex proxy on port {}", port);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn send_agent_input(
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "send_input",
        "prompt": prompt,
    });
    send_command_to_session(&agent_state, &session_id, cmd).await?;
    info!(target: "agent", "Agent input command sent for session_id={}", session_id);
    Ok(())
}

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
    info!(target: "agent", "Starting agent session wrapper for session_id={}", session_id);

    let agent_kind = {
        let db = state.db.lock().unwrap();
        crate::agent_runtime::factory::session_runtime_kind_name(&db, &session_id)
            .unwrap_or_else(|_| "claude_code".to_string())
    };

    ensure_sidecar_for_session(app, &agent_state, &session_id, channel).await?;
    let ensure_cmd = build_ensure_session_command(&state, &session_id, &agent_kind, cwd, api_key, base_url, model);
    send_command_to_session(&agent_state, &session_id, ensure_cmd).await?;

    let input_cmd = serde_json::json!({
        "type": "send_input",
        "prompt": prompt,
    });
    send_command_to_session(&agent_state, &session_id, input_cmd).await
}

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

    let debug_file = claude_dir.join("debug").join(format!("{}.txt", claude_session_id));
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

/// Find any active sidecar to send a global command (e.g. proxy management).
/// Returns the first available sidecar handle's session_id.
fn find_any_active_sidecar(
    sidecars: &HashMap<String, SidecarHandle>,
) -> Option<String> {
    sidecars.keys().next().cloned()
}

/// Parse the proxy port from captured sidecar stderr lines.
fn parse_proxy_port_from_stderr(lines: &[String]) -> Option<u16> {
    for line in lines.iter().rev() {
        // Match: [proxy-manager] Proxy started on port 50284, upstream=...
        if let Some(rest) = line.strip_prefix("[proxy-manager] Proxy started on port ") {
            if let Some(port_str) = rest.split(',').next() {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn start_codex_proxy(
    agent_state: State<'_, AgentState>,
    api_key: String,
    base_url: String,
) -> Result<u16, String> {
    info!(target: "agent", "Starting codex proxy upstream={}", base_url);

    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        find_any_active_sidecar(&sidecars)
    };
    let session_id = session_id.ok_or("No active sidecar to start proxy. Create a session first.")?;

    // Get the stderr lines Arc before sending the command
    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

    let cmd = serde_json::json!({
        "type": "start_proxy",
        "apiKey": api_key,
        "baseUrl": base_url,
    });
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    // Wait briefly for the sidecar to process and write stderr
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Parse the port from stderr
    let port = if let Some(lines) = stderr_lines {
        let captured = lines.lock().await;
        parse_proxy_port_from_stderr(&captured).unwrap_or(0)
    } else {
        0
    };

    *agent_state.proxy_port.lock().await = Some(port);
    info!(target: "agent", "Codex proxy started on port {}", port);
    Ok(port)
}

#[tauri::command]
pub async fn stop_codex_proxy(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    info!(target: "agent", "Stopping codex proxy");

    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        find_any_active_sidecar(&sidecars)
    };
    let session_id = session_id.ok_or("No active sidecar to stop proxy")?;

    let cmd = serde_json::json!({ "type": "stop_proxy" });
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    *agent_state.proxy_port.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn get_codex_proxy_port(
    agent_state: State<'_, AgentState>,
) -> Result<Option<u16>, String> {
    Ok(*agent_state.proxy_port.lock().await)
}
