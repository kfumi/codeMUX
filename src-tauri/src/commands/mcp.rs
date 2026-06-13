use log::{debug, info, warn};
use tauri::State;
use crate::AppState;
use crate::mcp::types::McpServer;
use crate::mcp::db;
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio::io::AsyncBufReadExt;

/// Result of probing a single MCP server.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeResult {
    pub connected: bool,
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub claude: usize,
    pub codex: usize,
    pub gemini: usize,
    pub opencode: usize,
    pub total: usize,
}

#[tauri::command]
pub fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let db = state.db.lock().unwrap();
    db::get_all_mcp_servers(&db).map_err(|e| format!("Failed to get MCP servers: {}", e))
}

#[tauri::command]
pub fn upsert_mcp_server(state: State<'_, AppState>, server: McpServer) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::upsert_mcp_server(&db, &server).map_err(|e| format!("Failed to save MCP server: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::delete_mcp_server(&db, &id).map_err(|e| format!("Failed to delete MCP server: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn toggle_mcp_app(
    state: State<'_, AppState>,
    server_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    crate::mcp::service::toggle_app(state.inner(), &server_id, &app, enabled)
}

#[tauri::command]
pub fn import_mcp_from_apps(state: State<'_, AppState>) -> Result<ImportResult, String> {
    crate::mcp::service::import_from_apps(state.inner())
}

fn mcp_initialize_request() -> String {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "codemux", "version": "0.1.0" }
        }
    });
    format!("{}\n", req)
}

fn extract_instructions(json_str: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let instructions = parsed.get("result")?.get("instructions")?.as_str()?;
    if instructions.is_empty() {
        None
    } else {
        Some(instructions.to_string())
    }
}

async fn probe_stdio(spec: &serde_json::Value) -> Result<ProbeResult, String> {
    let command = spec.get("command").and_then(|v| v.as_str()).ok_or("stdio missing command")?;
    let args: Vec<String> = spec.get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let env: HashMap<String, String> = spec.get("env")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();

    // On Windows, wrap bare commands in cmd /c
    #[cfg(target_os = "windows")]
    let (command, args) = {
        let cmd_lower = command.to_lowercase();
        let is_shell = cmd_lower == "cmd" || cmd_lower == "cmd.exe"
            || cmd_lower == "powershell" || cmd_lower == "pwsh";
        let needs_shell = !is_shell
            && !command.contains('/') && !command.contains('\\')
            && !command.ends_with(".exe") && !command.ends_with(".cmd") && !command.ends_with(".bat");
        if needs_shell {
            let mut new_args = vec!["/c".to_string(), command.to_string()];
            new_args.extend(args);
            ("cmd".to_string(), new_args)
        } else {
            (command.to_string(), args)
        }
    };
    #[cfg(not(target_os = "windows"))]
    let (command, args) = (command.to_string(), args);

    debug!(target: "mcp_probe", "stdio spawn command={} arg_count={}", command, args.len());
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .envs(&env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn()
        .map_err(|e| {
            warn!(target: "mcp_probe", "stdio spawn failed: {}", e);
            format!("Failed to spawn: {}", e)
        })?;

    let pid = child.id().unwrap_or(0);
    debug!(target: "mcp_probe", "stdio spawned pid={}", pid);

    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        if let Some(mut stdin) = child.stdin.take() {
            let req = mcp_initialize_request();
            debug!(target: "mcp_probe", "stdio sending initialize request bytes={}", req.len());
            stdin.write_all(req.as_bytes()).await.map_err(|e| format!("stdin write: {}", e))?;
            stdin.flush().await.map_err(|e| format!("stdin flush: {}", e))?;
            drop(stdin);
        }
        if let Some(stdout) = child.stdout.as_mut() {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.map_err(|e| format!("stdout read: {}", e))?;
                if n == 0 {
                    debug!(target: "mcp_probe", "stdio stdout EOF before initialize response");
                    break;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                debug!(target: "mcp_probe", "stdio read line bytes={}", n);
                if trimmed.starts_with('{') && trimmed.contains("\"result\"") {
                    debug!(target: "mcp_probe", "stdio received initialize response");
                    let instructions = extract_instructions(trimmed);
                    return Ok(ProbeResult { connected: true, instructions });
                }
                if trimmed.starts_with("Content-Length") {
                    line.clear();
                    reader.read_line(&mut line).await.ok();
                    line.clear();
                    let n2 = reader.read_line(&mut line).await.map_err(|e| format!("body read: {}", e))?;
                    if n2 > 0 {
                        let body = line.trim();
                        debug!(target: "mcp_probe", "stdio read framed body bytes={}", n2);
                        if body.contains("\"result\"") {
                            debug!(target: "mcp_probe", "stdio received framed initialize response");
                            let instructions = extract_instructions(body);
                            return Ok(ProbeResult { connected: true, instructions });
                        }
                    }
                }
            }
        }
        Ok(ProbeResult { connected: false, instructions: None }) as Result<ProbeResult, String>
    }).await;

    let _ = child.kill().await;
    match result {
        Ok(Ok(probe_result)) => {
            if probe_result.connected {
                info!(target: "mcp_probe", "stdio probe connected pid={} instructions={}", pid, probe_result.instructions.is_some());
            } else {
                warn!(target: "mcp_probe", "stdio probe failed pid={}", pid);
            }
            Ok(probe_result)
        }
        Ok(Err(e)) => {
            warn!(target: "mcp_probe", "stdio probe error pid={}: {}", pid, e);
            Err(e)
        }
        Err(_) => {
            warn!(target: "mcp_probe", "stdio probe timeout pid={}", pid);
            Err("Timed out".into())
        }
    }
}

async fn probe_http(spec: &serde_json::Value) -> Result<ProbeResult, String> {
    let url = spec.get("url").and_then(|v| v.as_str()).ok_or("http missing url")?;
    let headers: HashMap<String, String> = spec.get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();

    debug!(target: "mcp_probe", "http probe POST {}", url);
    let client = reqwest::Client::new();
    let mut req = client.post(url)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "codemux", "version": "0.1.0" }
            }
        }));
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let not_connected = ProbeResult { connected: false, instructions: None };
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        req.send()
    ).await.map_err(|_| {
        warn!(target: "mcp_probe", "http probe timeout");
        "Timed out".to_string()
    })?
     .map_err(|e| {
        warn!(target: "mcp_probe", "http probe request failed: {}", e);
        format!("Request failed: {}", e)
    })?;

    let status = resp.status();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("").to_string()).unwrap_or_default();
    debug!(target: "mcp_probe", "http probe HTTP {} content_type={}", status, content_type);
    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await.unwrap_or_else(|_| Ok(String::new())).unwrap_or_default();
        warn!(target: "mcp_probe", "http probe failed HTTP {}", status);
        return Err(format!("HTTP {} {}", status, body));
    }

    let body = tokio::time::timeout(std::time::Duration::from_secs(10), resp.text())
        .await
        .map_err(|_| {
            warn!(target: "mcp_probe", "http probe timeout while reading response body");
            "Timed out reading response body".to_string()
        })?
        .map_err(|e| format!("Read body: {}", e))?;
    debug!(target: "mcp_probe", "http probe response bytes={}", body.len());

    let json_str = if content_type.contains("text/event-stream") {
        body.lines().find_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("data:") && trimmed.contains("\"result\"") {
                trimmed.strip_prefix("data:").map(|s| s.trim())
            } else {
                None
            }
        })
    } else if body.contains("\"result\"") {
        Some(body.as_str())
    } else {
        None
    };

    match json_str {
        Some(json) => {
            let instructions = extract_instructions(json);
            info!(target: "mcp_probe", "http probe connected instructions={}", instructions.is_some());
            Ok(ProbeResult { connected: true, instructions })
        }
        None => {
            warn!(target: "mcp_probe", "http probe failed: no result in response");
            Ok(not_connected)
        }
    }
}

async fn probe_sse(spec: &serde_json::Value) -> Result<ProbeResult, String> {
    let url = spec.get("url").and_then(|v| v.as_str()).ok_or("sse missing url")?;
    let headers: HashMap<String, String> = spec.get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();

    debug!(target: "mcp_probe", "sse probe GET {}", url);
    let client = reqwest::Client::new();
    let mut req = client.get(url)
        .header("Accept", "text/event-stream");
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        req.send()
    ).await.map_err(|_| {
        warn!(target: "mcp_probe", "sse probe timeout");
        "Timed out".to_string()
    })?
     .map_err(|e| {
        warn!(target: "mcp_probe", "sse probe request failed: {}", e);
        format!("Request failed: {}", e)
    })?;

    let status = resp.status();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("").to_string()).unwrap_or_default();
    debug!(target: "mcp_probe", "sse probe HTTP {} content_type={}", status, content_type);

    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await.unwrap_or_else(|_| Ok(String::new())).unwrap_or_default();
        warn!(target: "mcp_probe", "sse probe failed HTTP {}", status);
        return Err(format!("HTTP {} {}", status, body));
    }

    let connected = content_type.contains("text/event-stream") || content_type.contains("application/json");
    if connected {
        info!(target: "mcp_probe", "sse probe connected");
    } else {
        warn!(target: "mcp_probe", "sse probe failed: unexpected content type {}", content_type);
    }
    Ok(ProbeResult { connected, instructions: None })
}

/// Probe a list of MCP servers concurrently.
pub async fn probe_servers(servers: &[McpServer]) -> HashMap<String, ProbeResult> {
    if servers.is_empty() {
        return HashMap::new();
    }
    let mut handles = Vec::new();
    for server in servers {
        let spec = server.server.clone();
        let name = server.name.clone();
        let server_type = spec.get("type").and_then(|v| v.as_str()).unwrap_or("stdio").to_string();
        debug!(target: "mcp_probe", "Queueing probe name={} type={}", name, server_type);
        handles.push(tokio::spawn(async move {
            let result = match server_type.as_str() {
                "stdio" => probe_stdio(&spec).await,
                "http" | "sse" => probe_http(&spec).await,
                _ => probe_sse(&spec).await,
            };
            let probe_result = result.unwrap_or(ProbeResult { connected: false, instructions: None });
            if probe_result.connected {
                info!(target: "mcp_probe", "Probe connected name={}", name);
            } else {
                warn!(target: "mcp_probe", "Probe failed name={}", name);
            }
            (name, probe_result)
        }));
    }

    let mut results = HashMap::new();
    for handle in handles {
        let (name, probe_result) = handle.await.unwrap_or_else(|_| (String::new(), ProbeResult { connected: false, instructions: None }));
        if !name.is_empty() {
            results.insert(name, probe_result);
        }
    }
    let connected = results.values().filter(|r| r.connected).count();
    let total = results.len();
    info!(target: "mcp_probe", "Probe summary: {}/{} connected", connected, total);
    results
}

#[tauri::command]
pub async fn probe_all_mcp_servers(state: State<'_, AppState>) -> Result<HashMap<String, bool>, String> {
    let servers = {
        let db = state.db.lock().unwrap();
        db::get_all_mcp_servers(&db).map_err(|e| format!("Failed to get servers: {}", e))?
    };
    let results = probe_servers(&servers).await;
    Ok(results.into_iter().map(|(k, v)| (k, v.connected)).collect())
}

#[tauri::command]
pub async fn probe_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<ProbeResult, String> {
    let server = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_mcp_server(&db, &id).map_err(|error| error.to_string())?
    }
    .ok_or_else(|| format!("Unknown MCP server: {id}"))?;

    let result = probe_servers(&[server]).await;
    let (_, probe) = result.into_iter().next().ok_or("Probe returned no result")?;
    Ok(probe)
}
