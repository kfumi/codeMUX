use tauri::State;
use crate::AppState;
use crate::mcp::types::{McpServer, McpTransport};
use crate::mcp::adapter::McpAdapter;
use crate::mcp::{db, adapters};
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio::io::AsyncBufReadExt;

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

async fn probe_stdio(transport: &McpTransport) -> Result<bool, String> {
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
    let mut child = tokio::process::Command::new(&command)
        .args(&args)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
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
                println!("[mcp-probe] stdio: read {} bytes: {}", n, trimmed);
                // Handle both newline-delimited JSON and Content-Length framing
                if trimmed.starts_with('{') && trimmed.contains("\"result\"") {
                    println!("[mcp-probe] stdio: got initialize response ✓");
                    return Ok(true);
                }
                if trimmed.starts_with("Content-Length") {
                    // Read the empty line after header, then the JSON body
                    line.clear();
                    reader.read_line(&mut line).await.ok();
                    line.clear();
                    let n2 = reader.read_line(&mut line).await.map_err(|e| format!("body read: {}", e))?;
                    if n2 > 0 {
                        println!("[mcp-probe] stdio: read body {} bytes: {}", n2, line.trim());
                        if line.contains("\"result\"") {
                            println!("[mcp-probe] stdio: got initialize response ✓");
                            return Ok(true);
                        }
                    }
                }
            }
        }
        Ok(false) as Result<bool, String>
    }).await;

    let _ = child.kill().await;
    match result {
        Ok(Ok(true)) => {
            println!("[mcp-probe] stdio: CONNECTED pid={}", pid);
            Ok(true)
        }
        Ok(Ok(false)) => {
            println!("[mcp-probe] stdio: FAILED pid={} (no valid response)", pid);
            Ok(false)
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

async fn probe_http_sse(transport: &McpTransport) -> Result<bool, String> {
    let (url, headers) = match transport {
        McpTransport::Http { url, headers } | McpTransport::Sse { url, headers } => (url.clone(), headers.clone()),
        _ => return Err("Not http/sse".into()),
    };
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
        let body = resp.text().await.unwrap_or_default();
        println!("[mcp-probe] {}: FAILED body: {}", transport_type, body);
        return Err(format!("HTTP {} {}", status, body));
    }

    let body = resp.text().await.map_err(|e| format!("Read body: {}", e))?;
    println!("[mcp-probe] {}: response ({} bytes): {}", transport_type, body.len(), body.chars().take(200).collect::<String>());

    // Response could be plain JSON or SSE format
    let ok = if body.contains("\"result\"") {
        true
    } else if content_type.contains("text/event-stream") {
        // Parse SSE: look for "data: {json}" lines containing "result"
        body.lines().any(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("data:") && trimmed.contains("\"result\"")
        })
    } else {
        false
    };

    if ok {
        println!("[mcp-probe] {}: CONNECTED ✓", transport_type);
    } else {
        println!("[mcp-probe] {}: FAILED (no result in response)", transport_type);
    }
    Ok(ok)
}

/// Probe a list of MCP servers concurrently. Returns name → connected?
pub async fn probe_servers(servers: &[McpServer]) -> HashMap<String, bool> {
    if servers.is_empty() {
        return HashMap::new();
    }
    let mut handles = Vec::new();
    for server in servers {
        let transport = server.transport.clone();
        let name = server.name.clone();
        println!("[mcp-probe] Queueing probe: {} ({})", name, transport.transport_type());
        handles.push(tokio::spawn(async move {
            let ok = match &transport {
                McpTransport::Stdio { .. } => probe_stdio(&transport).await,
                McpTransport::Http { .. } | McpTransport::Sse { .. } => probe_http_sse(&transport).await,
            };
            let success = ok.unwrap_or(false);
            println!("[mcp-probe] Result: {} => {}", name, if success { "CONNECTED" } else { "FAILED" });
            (name, success)
        }));
    }

    let mut results = HashMap::new();
    for handle in handles {
        if let Ok((name, ok)) = handle.await {
            results.insert(name, ok);
        }
    }
    let connected = results.values().filter(|v| **v).count();
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
    Ok(probe_servers(&servers).await)
}
