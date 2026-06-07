use tauri::State;
use crate::AppState;
use crate::mcp::types::{McpServer, McpTransport};
use crate::mcp::adapter::McpAdapter;
use crate::mcp::{db, adapters};
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio::io::AsyncBufReadExt;

/// Result of probing a single MCP server.
/// Distinguishes "connected but no instructions" from "probe failed".
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub connected: bool,
    pub instructions: Option<String>,
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

    // 双写到 ~/.claude.json
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::delete_mcp_server(&db, &id).map_err(|e| format!("Failed to delete MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn toggle_mcp_server(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    let new_state = db::toggle_mcp_server(&db, &id)
        .map_err(|e| format!("Failed to toggle MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(new_state)
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
    // MCP stdio transport uses newline-delimited JSON, not Content-Length framing
    format!("{}\n", req)
}

/// Extract the `instructions` field from an MCP initialize response JSON.
/// Returns `Some(instructions)` if the server provided them, `None` otherwise.
fn extract_instructions(json_str: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let instructions = parsed.get("result")?.get("instructions")?.as_str()?;
    if instructions.is_empty() {
        None
    } else {
        Some(instructions.to_string())
    }
}

async fn probe_stdio(transport: &McpTransport) -> Result<ProbeResult, String> {
    let McpTransport::Stdio { command, args, env } = transport else {
        return Err("Not a stdio transport".into());
    };

    // On Windows, wrap bare commands (npx, npm, node, etc.) in cmd /c
    // Skip if already a shell command (cmd, cmd.exe, powershell, etc.)
    #[cfg(target_os = "windows")]
    let (command, args) = {
        let cmd_lower = command.to_lowercase();
        let is_shell = cmd_lower == "cmd" || cmd_lower == "cmd.exe"
            || cmd_lower == "powershell" || cmd_lower == "pwsh";
        let needs_shell = !is_shell
            && !command.contains('/') && !command.contains('\\')
            && !command.ends_with(".exe") && !command.ends_with(".cmd") && !command.ends_with(".bat");
        if needs_shell {
            let mut new_args = vec!["/c".to_string(), command.clone()];
            new_args.extend(args.clone());
            ("cmd".to_string(), new_args)
        } else {
            (command.clone(), args.clone())
        }
    };
    #[cfg(not(target_os = "windows"))]
    let (command, args) = (command.clone(), args.clone());

    println!("[mcp-probe] stdio: spawning {} {}", command, args.join(" "));
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn()
        .map_err(|e| {
            println!("[mcp-probe] stdio: spawn failed: {}", e);
            format!("Failed to spawn: {}", e)
        })?;

    let pid = child.id().unwrap_or(0);
    println!("[mcp-probe] stdio: spawned pid={}", pid);

    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        if let Some(mut stdin) = child.stdin.take() {
            let req = mcp_initialize_request();
            println!("[mcp-probe] stdio: sending initialize request ({} bytes)", req.len());
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
                    println!("[mcp-probe] stdio: stdout EOF, no response");
                    break;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                println!("[mcp-probe] stdio: read {} bytes: {}", n, &trimmed[..trimmed.len().min(200)]);
                // Handle both newline-delimited JSON and Content-Length framing
                if trimmed.starts_with('{') && trimmed.contains("\"result\"") {
                    println!("[mcp-probe] stdio: got initialize response ✓");
                    let instructions = extract_instructions(trimmed);
                    return Ok(ProbeResult { connected: true, instructions });
                }
                if trimmed.starts_with("Content-Length") {
                    // Read the empty line after header, then the JSON body
                    line.clear();
                    reader.read_line(&mut line).await.ok();
                    line.clear();
                    let n2 = reader.read_line(&mut line).await.map_err(|e| format!("body read: {}", e))?;
                    if n2 > 0 {
                        let body = line.trim();
                        println!("[mcp-probe] stdio: read body {} bytes: {}", n2, &body[..body.len().min(200)]);
                        if body.contains("\"result\"") {
                            println!("[mcp-probe] stdio: got initialize response ✓");
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
            println!("[mcp-probe] stdio: {} pid={} instructions={}",
                if probe_result.connected { "CONNECTED" } else { "FAILED" },
                pid, probe_result.instructions.is_some());
            Ok(probe_result)
        }
        Ok(Err(e)) => {
            println!("[mcp-probe] stdio: ERROR pid={}: {}", pid, e);
            Err(e)
        }
        Err(_) => {
            println!("[mcp-probe] stdio: TIMEOUT pid={}", pid);
            Err("Timed out".into())
        }
    }
}

async fn probe_http(transport: &McpTransport) -> Result<ProbeResult, String> {
    let McpTransport::Http { url, headers } = transport else {
        return Err("Not http".into());
    };
    let url = url.clone();
    let headers = headers.clone();
    let transport_type = transport.transport_type();
    println!("[mcp-probe] {}: POST {}", transport_type, url);
    let client = reqwest::Client::new();
    let mut req = client.post(&url)
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
        println!("[mcp-probe] {}: TIMEOUT", transport_type);
        "Timed out".to_string()
    })?
     .map_err(|e| {
        println!("[mcp-probe] {}: request failed: {}", transport_type, e);
        format!("Request failed: {}", e)
    })?;

    let status = resp.status();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("").to_string()).unwrap_or_default();
    println!("[mcp-probe] {}: HTTP {} (Content-Type: {})", transport_type, status, content_type);
    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await.unwrap_or_else(|_| Ok(String::new())).unwrap_or_default();
        println!("[mcp-probe] {}: FAILED body: {}", transport_type, body);
        return Err(format!("HTTP {} {}", status, body));
    }

    // Wrap body read in timeout to prevent indefinite blocking on slow servers
    let body = tokio::time::timeout(std::time::Duration::from_secs(10), resp.text())
        .await
        .map_err(|_| {
            println!("[mcp-probe] {}: TIMEOUT reading body", transport_type);
            "Timed out reading response body".to_string()
        })?
        .map_err(|e| format!("Read body: {}", e))?;
    println!("[mcp-probe] {}: response ({} bytes): {}", transport_type, body.len(), body.chars().take(200).collect::<String>());

    // Response could be plain JSON or SSE format
    // Check SSE FIRST — SSE bodies also contain "result" but are not valid JSON
    let json_str = if content_type.contains("text/event-stream") {
        // Parse SSE: look for "data: {json}" lines containing "result"
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
            println!("[mcp-probe] {}: CONNECTED ✓ instructions={}", transport_type, instructions.is_some());
            Ok(ProbeResult { connected: true, instructions })
        }
        None => {
            println!("[mcp-probe] {}: FAILED (no result in response)", transport_type);
            Ok(not_connected)
        }
    }
}

async fn probe_sse(transport: &McpTransport) -> Result<ProbeResult, String> {
    let McpTransport::Sse { url, headers } = transport else {
        return Err("Not an SSE transport".into());
    };
    println!("[mcp-probe] sse: GET {}", url);
    let client = reqwest::Client::new();
    let mut req = client.get(url)
        .header("Accept", "text/event-stream");
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        req.send()
    ).await.map_err(|_| {
        println!("[mcp-probe] sse: TIMEOUT");
        "Timed out".to_string()
    })?
     .map_err(|e| {
        println!("[mcp-probe] sse: request failed: {}", e);
        format!("Request failed: {}", e)
    })?;

    let status = resp.status();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("").to_string()).unwrap_or_default();
    println!("[mcp-probe] sse: HTTP {} (Content-Type: {})", status, content_type);

    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await.unwrap_or_else(|_| Ok(String::new())).unwrap_or_default();
        println!("[mcp-probe] sse: FAILED body: {}", body.chars().take(200).collect::<String>());
        return Err(format!("HTTP {} {}", status, body));
    }

    // SSE endpoint should return text/event-stream
    let connected = content_type.contains("text/event-stream") || content_type.contains("application/json");
    if connected {
        println!("[mcp-probe] sse: CONNECTED ✓ (SSE stream available)");
    } else {
        println!("[mcp-probe] sse: FAILED (unexpected Content-Type: {})", content_type);
    }
    // SSE probes only verify endpoint reachability; instructions come from
    // the full MCP handshake which the SDK handles via startup().
    Ok(ProbeResult { connected, instructions: None })
}

/// Probe a list of MCP servers concurrently.
/// Returns name → ProbeResult (connected status + optional instructions).
pub async fn probe_servers(servers: &[McpServer]) -> HashMap<String, ProbeResult> {
    if servers.is_empty() {
        return HashMap::new();
    }
    let mut handles = Vec::new();
    for server in servers {
        let transport = server.transport.clone();
        let name = server.name.clone();
        println!("[mcp-probe] Queueing probe: {} ({})", name, transport.transport_type());
        handles.push(tokio::spawn(async move {
            let result = match &transport {
                McpTransport::Stdio { .. } => probe_stdio(&transport).await,
                McpTransport::Http { .. } => probe_http(&transport).await,
                McpTransport::Sse { .. } => probe_sse(&transport).await,
            };
            let probe_result = result.unwrap_or(ProbeResult { connected: false, instructions: None });
            println!("[mcp-probe] Result: {} => {} instructions={}", name,
                if probe_result.connected { "CONNECTED" } else { "FAILED" },
                probe_result.instructions.is_some());
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
    println!("[mcp-probe] Summary: {}/{} connected", connected, total);
    results
}

#[tauri::command]
pub async fn probe_all_mcp_servers(state: State<'_, AppState>) -> Result<HashMap<String, bool>, String> {
    let servers = {
        let db = state.db.lock().unwrap();
        db::get_enabled_mcp_servers(&db).map_err(|e| format!("Failed to get servers: {}", e))?
    };
    let results = probe_servers(&servers).await;
    // Tauri command returns bool for UI — now uses ProbeResult.connected
    Ok(results.into_iter().map(|(k, v)| (k, v.connected)).collect())
}
