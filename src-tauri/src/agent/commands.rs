use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use crate::config::types::AgentKind;
use crate::db::operations;
use log::{debug, info, warn};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use super::{spawn_sidecar, SidecarHandle};

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())
}

fn get_agent_session_id(
    state: &crate::AppState,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    operations::get_agent_session_mapping(&db, app_session_id, agent_kind)
        .map(|mapping| mapping.map(|record| record.agent_session_id))
        .map_err(|err| err.to_string())
}

fn find_claude_session_jsonl(claude_dir: &Path, claude_session_id: &str) -> Option<PathBuf> {
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

fn first_non_empty_line(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.ok()?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn read_codex_session_meta_id(path: &Path) -> Option<String> {
    let line = first_non_empty_line(path)?;
    let value = serde_json::from_str::<serde_json::Value>(&line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_meta") {
        return None;
    }

    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(|entry| entry.as_str())
        .map(|id| id.to_string())
}

fn collect_codex_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    use std::fs;

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            collect_codex_jsonl_files(&path, output);
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn find_codex_session_jsonl(sessions_dir: &Path, codex_session_id: &str) -> Option<PathBuf> {
    use std::fs;

    let mut candidates = Vec::new();
    collect_codex_jsonl_files(sessions_dir, &mut candidates);

    candidates
        .into_iter()
        .filter(|path| read_codex_session_meta_id(path).as_deref() == Some(codex_session_id))
        .max_by_key(|path| {
            fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0)
        })
}

#[tauri::command]
pub async fn load_claude_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    debug!(target: "agent", "Loading Claude session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();

    let Some(claude_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::ClaudeCode)?
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

    let file =
        fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
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

    info!(target: "agent", "Loaded {} messages from Claude JSONL for app_session_id={}", messages.len(), app_session_id);
    Ok(messages)
}

/// Convert a codex JSONL response_item to a Claude-compatible message format.
/// Codex uses: {type: "response_item", payload: {type, role, content, ...}}
/// Claude uses: {type: "assistant"|"user", message: {role, content: [...]}, ...}
fn convert_codex_item_to_claude_format(val: &serde_json::Value) -> Option<serde_json::Value> {
    let item_type = val.get("type")?.as_str()?;
    let payload = val.get("payload")?;
    let timestamp = val.get("timestamp").cloned();

    if item_type == "response_item" {
        let payload_type = payload.get("type")?.as_str()?;
        let role = payload.get("role").and_then(|r| r.as_str());

        // Assistant text message
        if role == Some("assistant") {
            let content_blocks = payload.get("content")?;
            // Convert codex content format to claude format
            let mut claude_content = Vec::new();
            if let Some(arr) = content_blocks.as_array() {
                for block in arr {
                    let block_type = block.get("type")?.as_str()?;
                    if block_type == "output_text" {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            claude_content.push(serde_json::json!({"type": "text", "text": text}));
                        }
                    } else if block_type == "reasoning" {
                        // Skip reasoning blocks for now
                    }
                }
            }
            if claude_content.is_empty() {
                return None;
            }
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": claude_content
                }
            }));
        }

        // User message
        if role == Some("user") {
            let content_blocks = payload.get("content")?;
            let mut text_parts = Vec::new();
            if let Some(arr) = content_blocks.as_array() {
                for block in arr {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if block_type == "input_text" {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push(text.to_string());
                        }
                    }
                }
            }
            if text_parts.is_empty() {
                return None;
            }
            let content = text_parts.join("\n");
            // Skip Codex environment context injections (not real user messages)
            if content.starts_with("<environment_context>") {
                return None;
            }
            return Some(serde_json::json!({
                "type": "user",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": content
                }
            }));
        }

        // Function call → tool_use
        if payload_type == "function_call" {
            let name = payload.get("name")?.as_str()?;
            let call_id = payload.get("call_id")?.as_str()?;
            let arguments = payload.get("arguments");
            let input: serde_json::Value = if let Some(args_str) = arguments.and_then(|a| a.as_str()) {
                serde_json::from_str(args_str).unwrap_or_else(|_| serde_json::json!({"raw": args_str}))
            } else {
                arguments.cloned().unwrap_or(serde_json::json!({}))
            };
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": input
                    }]
                }
            }));
        }

        // Function call output → user tool_result
        if payload_type == "function_call_output" {
            let call_id = payload.get("call_id")?.as_str()?;
            let output = payload.get("output").and_then(|o| o.as_str()).unwrap_or("");
            return Some(serde_json::json!({
                "type": "user",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call_id,
                        "content": output
                    }]
                }
            }));
        }
    }

    None
}

#[tauri::command]
pub async fn load_codex_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    debug!(target: "agent", "Loading Codex session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();
    let Some(codex_session_id) = get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        info!(target: "agent", "No Codex mapping found for app_session_id={}", app_session_id);
        return Ok(messages);
    };

    let sessions_dir = home_dir()?.join(".codex").join("sessions");
    let Some(jsonl_path) = find_codex_session_jsonl(&sessions_dir, &codex_session_id) else {
        info!(
            target: "agent",
            "No Codex JSONL found for app_session_id={} codex_session_id={} dir={}",
            app_session_id,
            codex_session_id,
            sessions_dir.display()
        );
        return Ok(messages);
    };

    debug!(target: "agent", "Reading Codex JSONL from {}", jsonl_path.display());
    let file = match fs::File::open(&jsonl_path) {
        Ok(file) => file,
        Err(error) => return Err(format!("Failed to open Codex JSONL: {}", error)),
    };
    let reader = BufReader::new(file);

    // Collect all raw events for two-pass processing
    let raw_events: Vec<serde_json::Value> = reader
        .lines()
        .filter_map(|line_result| line_result.ok())
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line.trim()).ok())
        .collect();

    // --- Pass 1: Identify turns and collect per-turn stats ---
    // Each turn starts with a turn_context and has its own task_complete + token_counts.
    // We compute per-turn token deltas so each turn gets its own result event.

    #[derive(Default)]
    struct TurnInfo {
        last_token_usage: Option<serde_json::Value>,
        model_context_window: Option<u64>,
        duration_ms: Option<u64>,
        last_assistant_msg_idx: Option<usize>, // index in `messages`
    }

    let mut turns: Vec<TurnInfo> = Vec::new();
    let mut msg_idx: usize = 0;

    for val in &raw_events {
        let item_type = val.get("type").and_then(|t| t.as_str());

        // Turn boundary
        if item_type == Some("turn_context") {
            turns.push(TurnInfo::default());
        }

        let current_turn = if turns.is_empty() {
            turns.push(TurnInfo::default());
            turns.last_mut().unwrap()
        } else {
            turns.last_mut().unwrap()
        };

        if item_type == Some("event_msg") {
            if let Some(payload) = val.get("payload") {
                let payload_type = payload.get("type").and_then(|t| t.as_str());
                match payload_type {
                    Some("token_count") => {
                        if let Some(info) = payload.get("info") {
                            if let Some(usage) = info.get("last_token_usage") {
                                current_turn.last_token_usage = Some(usage.clone());
                            }
                            // Also capture model_context_window for the frontend
                            if let Some(ctx) = info.get("model_context_window").and_then(|v| v.as_u64()) {
                                current_turn.model_context_window = Some(ctx);
                            }
                        }
                    }
                    Some("task_complete") => {
                        if let Some(dm) = payload.get("duration_ms").and_then(|d| d.as_u64()) {
                            current_turn.duration_ms = Some(dm);
                        }
                    }
                    _ => {}
                }
            }
            continue; // event_msg entries are not converted to messages
        }

        // Track which message index the last assistant message of this turn lands at
        if let Some(converted) = convert_codex_item_to_claude_format(val) {
            if converted.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                current_turn.last_assistant_msg_idx = Some(msg_idx);
            }
            messages.push(converted);
            msg_idx += 1;
        }
    }

    // --- Pass 2: Insert synthetic result events per turn ---
    // Each turn's last token_count is cumulative; display as-is (total so far).
    // Insert in reverse order so indices stay valid.

    struct TurnResult {
        insert_at: usize, // insert AFTER this message index
        result: serde_json::Value,
    }
    let mut turn_results: Vec<TurnResult> = Vec::new();

    for (i, turn) in turns.iter().enumerate() {
        let usage = match &turn.last_token_usage {
            Some(u) => u,
            None => continue,
        };

        let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cached = usage.get("cached_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let total = input + output;

        if input > 0 || output > 0 {
            if let Some(insert_at) = turn.last_assistant_msg_idx {
                let mut result = serde_json::json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "uuid": format!("synthetic-codex-turn-{}-{}", app_session_id, i),
                    "session_id": app_session_id,
                    "duration_ms": turn.duration_ms.unwrap_or(0),
                    "duration_api_ms": 0,
                    "num_turns": 1,
                    "result": "",
                    "total_cost_usd": 0,
                    "usage": {
                        "input_tokens": input,
                        "output_tokens": output,
                        "cache_read_input_tokens": cached,
                        "cache_creation_input_tokens": 0
                    },
                    "last_token_usage": {
                        "input_tokens": input,
                        "output_tokens": output,
                        "cached_input_tokens": cached,
                        "total_tokens": total
                    }
                });
                if let Some(ctx) = turn.model_context_window {
                    result["model_context_window"] = serde_json::json!(ctx);
                }
                turn_results.push(TurnResult { insert_at, result });
            }
        }
    }

    // Insert result events in reverse order to preserve indices
    for tr in turn_results.into_iter().rev() {
        messages.insert(tr.insert_at + 1, tr.result);
    }

    info!(target: "agent", "Loaded {} messages from Codex JSONL for app_session_id={}", messages.len(), app_session_id);
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
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if handle_agent_session_mapping_event(&app_handle, &event) {
                continue;
            }
            let ch = shared_channel.lock().await;
            let _ = ch.send(event);
        }
        info!(target: "agent", "Sidecar stream closed for session_id={}", session_id_clone);
    });

    let mut sidecars = agent_state.sidecars.lock().await;
    sidecars.insert(session_id.to_string(), handle);

    Ok(())
}

fn handle_agent_session_mapping_event(app: &AppHandle, event: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(event) else {
        return false;
    };

    if value.get("type").and_then(|entry| entry.as_str()) != Some("agent_session_mapping") {
        return false;
    }

    let Some(app_session_id) = value
        .get("app_session_id")
        .and_then(|entry| entry.as_str())
    else {
        warn!(target: "agent", "Dropping mapping event without app_session_id");
        return true;
    };
    let Some(agent_kind_str) = value.get("agent_kind").and_then(|entry| entry.as_str()) else {
        warn!(target: "agent", "Dropping mapping event without agent_kind app_session_id={}", app_session_id);
        return true;
    };
    let Some(agent_session_id) = value
        .get("agent_session_id")
        .and_then(|entry| entry.as_str())
    else {
        warn!(target: "agent", "Dropping mapping event without agent_session_id app_session_id={}", app_session_id);
        return true;
    };

    let Ok(agent_kind) = AgentKind::from_str(agent_kind_str) else {
        warn!(
            target: "agent",
            "Dropping mapping event with unsupported agent_kind={} app_session_id={}",
            agent_kind_str,
            app_session_id
        );
        return true;
    };

    let state = app.state::<crate::AppState>();
    let db = state.db.lock().unwrap();
    match operations::upsert_agent_session_mapping(&db, app_session_id, agent_kind, agent_session_id) {
        Ok(_) => {
            info!(
                target: "agent",
                "Upserted agent session mapping app_session_id={} agent_kind={} agent_session_id={}",
                app_session_id,
                agent_kind.as_str(),
                agent_session_id
            );
        }
        Err(error) => {
            warn!(
                target: "agent",
                "Failed to upsert agent session mapping app_session_id={} agent_kind={} error={}",
                app_session_id,
                agent_kind.as_str(),
                error
            );
        }
    }

    true
}

fn build_ensure_session_command(
    state: &crate::AppState,
    session_id: &str,
    agent_kind: &str,
    cwd: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    codex_needs_proxy: Option<bool>,
) -> serde_json::Value {
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
    if let Some(effort) = reasoning_effort {
        cmd["reasoningEffort"] = serde_json::Value::String(effort);
    }
    if let Some(needs_proxy) = codex_needs_proxy {
        cmd["codexNeedsProxy"] = serde_json::Value::Bool(needs_proxy);
    }
    if let Ok(parsed_agent_kind) = AgentKind::from_str(agent_kind) {
        match get_agent_session_id(state, session_id, parsed_agent_kind) {
            Ok(Some(agent_session_id)) => {
                cmd["agentSessionId"] = serde_json::Value::String(agent_session_id);
            }
            Ok(None) => {}
            Err(error) => warn!(
                target: "agent",
                "Failed to load agent session mapping for session_id={} agent_kind={} error={}",
                session_id,
                agent_kind,
                error
            ),
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
    reasoning_effort: Option<String>,
    codex_needs_proxy: Option<bool>,
) -> Result<(), String> {
    info!(
        target: "agent",
        "Ensuring agent session session_id={} cwd={} model={} reasoning_effort={} has_api_key={} has_base_url={}",
        session_id,
        cwd,
        model.as_deref().unwrap_or("default"),
        reasoning_effort.as_deref().unwrap_or("medium"),
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

    let cmd = build_ensure_session_command(&state, &session_id, &agent_kind, cwd, api_key, base_url, model, reasoning_effort, codex_needs_proxy);

    // If the proxy is already running (e.g. started manually from settings),
    // tell the sidecar to use it directly instead of starting a new one.
    send_command_to_session(&agent_state, &session_id, cmd).await?;
    info!(target: "agent", "Agent ensure command sent for session_id={} agent_kind={}", session_id, agent_kind);

    // Parse proxy port from stderr if proxy was auto-started
    if agent_kind == "codex" && agent_state.proxy_port.lock().await.is_none() {
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
    reasoning_effort: Option<String>,
    codex_needs_proxy: Option<bool>,
) -> Result<(), String> {
    info!(target: "agent", "Starting agent session wrapper for session_id={}", session_id);

    let agent_kind = {
        let db = state.db.lock().unwrap();
        crate::agent_runtime::factory::session_runtime_kind_name(&db, &session_id)
            .unwrap_or_else(|_| "claude_code".to_string())
    };

    ensure_sidecar_for_session(app, &agent_state, &session_id, channel).await?;
    let ensure_cmd = build_ensure_session_command(&state, &session_id, &agent_kind, cwd, api_key, base_url, model, reasoning_effort, codex_needs_proxy);

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
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;
    let claude_dir = home_dir()?.join(".claude");

    let Some(claude_session_id) = get_agent_session_id(state.inner(), &app_session_id, AgentKind::ClaudeCode)?
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

    info!(
        target: "agent",
        "Deleted {} Claude session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

#[tauri::command]
pub async fn delete_codex_session_files(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;

    let Some(codex_session_id) = get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        debug!(target: "agent", "No Codex session mapping found for session_id={}", app_session_id);
        return Ok(vec![]);
    };

    info!(
        target: "agent",
        "Deleting Codex session files for app_session_id={} codex_session_id={}",
        app_session_id,
        codex_session_id
    );

    let mut deleted = Vec::new();
    let sessions_dir = home_dir()?.join(".codex").join("sessions");

    if sessions_dir.exists() {
        let mut candidates = Vec::new();
        collect_codex_jsonl_files(&sessions_dir, &mut candidates);

        for path in candidates {
            if read_codex_session_meta_id(&path).as_deref() == Some(&codex_session_id) {
                let _ = fs::remove_file(&path);
                deleted.push(path.to_string_lossy().to_string());
            }
        }
    }

    info!(
        target: "agent",
        "Deleted {} Codex session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

/// Find any active sidecar to send a global command (e.g. proxy management).
/// Skips the dedicated proxy sidecar — it has no Codex session initialized.
fn find_any_active_sidecar(
    sidecars: &HashMap<String, SidecarHandle>,
) -> Option<String> {
    sidecars
        .keys()
        .find(|id| id.as_str() != PROXY_SESSION_ID)
        .cloned()
}

/// Parse the proxy port from captured sidecar stderr lines.
fn parse_proxy_port_from_stderr(lines: &[String]) -> Option<u16> {
    for line in lines.iter().rev() {
        if let Some(rest) = line.strip_prefix("[proxy-manager] Proxy started on port ") {
            if let Some(port_str) = rest.split(',').next() {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }

        if let Some(rest) = line.strip_prefix("[proxy-manager] Reusing existing proxy on port ") {
            if let Ok(port) = rest.trim().parse::<u16>() {
                return Some(port);
            }
        }
    }

    None
}

#[allow(dead_code)]
async fn probe_local_proxy_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/__codemux_proxy_health", port);
    match reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[allow(dead_code)]
async fn get_live_proxy_port(agent_state: &State<'_, AgentState>) -> Option<u16> {
    let current = *agent_state.proxy_port.lock().await;
    let Some(port) = current else {
        return None;
    };

    if port == 0 {
        *agent_state.proxy_port.lock().await = None;
        return None;
    }

    if probe_local_proxy_health(port).await {
        return Some(port);
    }

    warn!(target: "agent", "Cached codex proxy port {} failed health check; clearing stale proxy state", port);
    *agent_state.proxy_port.lock().await = None;
    None
}

#[cfg(test)]
mod tests {
    use super::{find_codex_session_jsonl, parse_proxy_port_from_stderr};

    #[test]
    fn find_codex_session_jsonl_matches_only_session_meta_payload_id() {
        use std::fs;

        let base = std::env::temp_dir().join(format!("codemux-codex-test-{}", uuid::Uuid::new_v4()));
        let sessions_dir = base.join("2026").join("06").join("11");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("wrong-id.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong-session\",\"timestamp\":\"2026-06-11T10:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"wrong\"}]}}\n"
            ),
        )
        .unwrap();
        fs::write(
            sessions_dir.join("target.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"target-session\",\"timestamp\":\"2026-06-11T11:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}}\n"
            ),
        )
        .unwrap();

        let matched = find_codex_session_jsonl(&base, "target-session").expect("matching file should exist");
        assert_eq!(matched, sessions_dir.join("target.jsonl"));

        let missing = find_codex_session_jsonl(&base, "missing-session");
        assert!(missing.is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_proxy_port_from_reuse_log() {
        let lines = vec![
            "[codex-compat-proxy] port 15722 busy, retrying (1/5)...".to_string(),
            "[proxy-manager] Reusing existing proxy on port 15722".to_string(),
        ];

        assert_eq!(parse_proxy_port_from_stderr(&lines), Some(15722));
    }

}

const PROXY_SESSION_ID: &str = "__codex_proxy__";

#[tauri::command]
pub async fn start_codex_proxy(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    api_key: String,
    base_url: String,
    provider_name: String,
    codex_needs_proxy: Option<bool>,
) -> Result<u16, String> {
    info!(target: "agent", "Starting codex proxy upstream={} provider={}", base_url, provider_name);

    // Find an existing sidecar, or spawn a dedicated one for the proxy
    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        find_any_active_sidecar(&sidecars)
    };

    let session_id = match session_id {
        Some(id) => id,
        None => {
            info!(target: "agent", "No active sidecar, spawning dedicated proxy sidecar");
            let (handle, mut rx) = spawn_sidecar(&app, tauri::ipc::Channel::new(|_| Ok(()))).await?;

            // Drain the event stream in the background
            let session_id_clone = PROXY_SESSION_ID.to_string();
            tokio::spawn(async move {
                while rx.recv().await.is_some() {}
                info!(target: "agent", "Proxy sidecar stream closed for {}", session_id_clone);
            });

            agent_state.sidecars.lock().await.insert(PROXY_SESSION_ID.to_string(), handle);
            PROXY_SESSION_ID.to_string()
        }
    };

    // Get the stderr lines Arc before sending the command
    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

    let mut cmd = serde_json::json!({
        "type": "start_proxy",
        "apiKey": api_key,
        "baseUrl": base_url,
        "providerName": provider_name,
    });
    if let Some(needs_proxy) = codex_needs_proxy {
        cmd["codexNeedsProxy"] = serde_json::Value::Bool(needs_proxy);
    }
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    // Wait until stderr confirms either a fresh start or successful reuse.
    let timeout = std::time::Duration::from_secs(5);
    let poll_interval = std::time::Duration::from_millis(100);
    let deadline = tokio::time::Instant::now() + timeout;

    while tokio::time::Instant::now() < deadline {
        if let Some(lines) = &stderr_lines {
            let captured = lines.lock().await;
            if let Some(port) = parse_proxy_port_from_stderr(&captured) {
                drop(captured);
                *agent_state.proxy_port.lock().await = Some(port);
                info!(target: "agent", "Codex proxy started on port {}", port);
                return Ok(port);
            }
        }

        tokio::time::sleep(poll_interval).await;
    }

    warn!(
        target: "agent",
        "Codex proxy did not confirm startup within {}ms; leaving proxy_port unset",
        timeout.as_millis()
    );
    Err("Codex proxy did not confirm startup. Check sidecar logs for details.".to_string())
}

#[tauri::command]
pub async fn stop_codex_proxy(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    info!(target: "agent", "Stopping codex proxy");

    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        // Prefer the dedicated proxy sidecar if it exists
        if sidecars.contains_key(PROXY_SESSION_ID) {
            Some(PROXY_SESSION_ID.to_string())
        } else {
            find_any_active_sidecar(&sidecars)
        }
    };
    let session_id = session_id.ok_or("No active sidecar to stop proxy")?;

    let cmd = serde_json::json!({ "type": "stop_proxy" });
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    // Wait for the proxy to fully release the port
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Clean up the dedicated proxy sidecar
    if session_id == PROXY_SESSION_ID {
        if let Some(mut handle) = agent_state.sidecars.lock().await.remove(PROXY_SESSION_ID) {
            handle.shutdown().await;
            info!(target: "agent", "Dedicated proxy sidecar shut down");
        }
    }

    *agent_state.proxy_port.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn get_codex_proxy_port(
    agent_state: State<'_, AgentState>,
) -> Result<Option<u16>, String> {
    Ok(*agent_state.proxy_port.lock().await)
}
