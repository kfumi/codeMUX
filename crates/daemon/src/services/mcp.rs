use crate::mcp::db;
use crate::mcp::types::McpServer;
use crate::AppState;
use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::Mutex;

use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;

/// Result of probing a single MCP server.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeResult {
    pub connected: bool,
    pub instructions: Option<String>,
    /// Tool names from `tools/list`(连接成功但未拉取到时为空数组)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

impl ProbeResult {
    fn not_connected() -> Self {
        ProbeResult {
            connected: false,
            instructions: None,
            tools: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub claude: usize,
    pub codex: usize,
    pub gemini: usize,
    pub opencode: usize,
    pub total: usize,
}

fn get_mcp_servers_from_db(db: &Mutex<rusqlite::Connection>) -> Result<Vec<McpServer>, String> {
    let conn = db.lock().unwrap();
    db::get_all_mcp_servers(&conn).map_err(|e| format!("Failed to get MCP servers: {}", e))
}

pub fn get_mcp_servers_impl(state: &AppState) -> Result<Vec<McpServer>, String> {
    // 先克隆配置再取 DB:内置条目的 `tools` 要按**当前开关**现算,而取 DB 行也要持锁。
    // 两把锁不嵌套,免得与别处的加锁顺序打架。
    let config = state.config.lock().unwrap().clone();
    let mut servers = get_mcp_servers_from_db(&state.db)?;
    // 内置控制 server 动态追加(不落 DB):设置页展示为「内置」,
    // 无需刷新/导入,写入路径按 id/name 拒绝改删。
    servers.push(crate::builtin_mcp::builtin_server_entry(
        &std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("codemux-daemon")),
        &state.app_data_dir,
        Some(&config),
    ));
    log::info!(target: "mcp_fetch", "get_mcp_servers returning {} entries", servers.len());
    Ok(servers)
}

/// 该 id/name 是否属于保留名:内置 server 现名,或它的历史名。
fn is_reserved_server_name(id_or_name: &str) -> bool {
    id_or_name == crate::builtin_mcp::SERVER_NAME
        || crate::builtin_mcp::LEGACY_SERVER_NAMES.contains(&id_or_name)
}

/// 内置 server 保护:用户侧写入(upsert/toggle/delete)不得触碰内置 id/name。
///
/// 历史名(`codemux-browser`)一并保留:它已不再是我们的 key,但历史轨迹里的旧全名
/// 仍按它识别 —— 用户自建一个同名 server 会让人读日志与轨迹时串味。
fn reject_builtin(id_or_name: &str) -> Result<(), String> {
    if is_reserved_server_name(id_or_name) {
        Err("内置 MCP server 不可修改或删除".to_string())
    } else {
        Ok(())
    }
}

pub fn upsert_mcp_server_impl(state: &AppState, server: McpServer) -> Result<(), String> {
    reject_builtin(&server.id)?;
    if is_reserved_server_name(&server.name) {
        return Err("内置 MCP server 名称保留,不可占用".to_string());
    }
    let db = state.db.lock().unwrap();
    db::upsert_mcp_server(&db, &server).map_err(|e| format!("Failed to save MCP server: {}", e))?;
    Ok(())
}

pub fn delete_mcp_server_impl(state: &AppState, id: String) -> Result<(), String> {
    reject_builtin(&id)?;
    let db = state.db.lock().unwrap();
    db::delete_mcp_server(&db, &id).map_err(|e| format!("Failed to delete MCP server: {}", e))?;
    Ok(())
}

pub fn toggle_mcp_app_impl(
    state: &AppState,
    server_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    reject_builtin(&server_id)?;
    crate::mcp::service::toggle_app(state, &server_id, &app, enabled)
}

pub fn import_mcp_from_apps_impl(state: &AppState) -> Result<ImportResult, String> {
    crate::mcp::service::import_from_apps(state)
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

fn mcp_initialized_notification() -> String {
    let n = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    format!("{}\n", n)
}

fn mcp_tools_list_request() -> String {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
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

fn extract_tool_names(json_str: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(json_str)
        .ok()
        .and_then(|v| v.get("result").cloned())
        .and_then(|result| result.get("tools").cloned())
        .and_then(|tools| tools.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

async fn probe_stdio(spec: &serde_json::Value) -> Result<ProbeResult, String> {
    let command = spec
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("stdio missing command")?;
    let args: Vec<String> = spec
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let env: HashMap<String, String> = spec
        .get("env")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // On Windows, wrap bare commands in cmd /c
    #[cfg(target_os = "windows")]
    let (command, args) = {
        let cmd_lower = command.to_lowercase();
        let is_shell = cmd_lower == "cmd"
            || cmd_lower == "cmd.exe"
            || cmd_lower == "powershell"
            || cmd_lower == "pwsh";
        let needs_shell = !is_shell
            && !command.contains('/')
            && !command.contains('\\')
            && !command.ends_with(".exe")
            && !command.ends_with(".cmd")
            && !command.ends_with(".bat");
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
    let mut child = cmd.spawn().map_err(|e| {
        warn!(target: "mcp_probe", "stdio spawn failed: {}", e);
        format!("Failed to spawn: {}", e)
    })?;

    let pid = child.id().unwrap_or(0);
    debug!(target: "mcp_probe", "stdio spawned pid={}", pid);

    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut initialized: Option<ProbeResult> = None;
        if let Some(mut stdin) = child.stdin.take() {
            let req = mcp_initialize_request();
            debug!(target: "mcp_probe", "stdio sending initialize request bytes={}", req.len());
            stdin.write_all(req.as_bytes()).await.map_err(|e| format!("stdin write: {}", e))?;
            stdin.flush().await.map_err(|e| format!("stdin flush: {}", e))?;
            if let Some(stdout) = child.stdout.as_mut() {
                let mut reader = tokio::io::BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    let n = reader.read_line(&mut line).await.map_err(|e| format!("stdout read: {}", e))?;
                    if n == 0 {
                        debug!(target: "mcp_probe", "stdio stdout EOF");
                        break;
                    }
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    debug!(target: "mcp_probe", "stdio read line bytes={}", n);
                    let is_json = trimmed.starts_with('{');
                    let is_framed = trimmed.starts_with("Content-Length");
                    let mut body: Option<String> = None;
                    if is_json {
                        body = Some(trimmed.to_string());
                    } else if is_framed {
                        line.clear();
                        reader.read_line(&mut line).await.ok();
                        line.clear();
                        let n2 = reader.read_line(&mut line).await.map_err(|e| format!("body read: {}", e))?;
                        if n2 > 0 {
                            debug!(target: "mcp_probe", "stdio read framed body bytes={}", n2);
                            body = Some(line.trim().to_string());
                        }
                    }
                    let Some(body) = body.as_deref() else { continue };
                    if initialized.is_none() && body.contains("\"result\"") && !body.contains("\"tools\"") {
                        debug!(target: "mcp_probe", "stdio received initialize response");
                        let instructions = extract_instructions(body);
                        initialized = Some(ProbeResult { connected: true, instructions, tools: Vec::new() });
                        // 继续握手:initialized 通知 + tools/list,把工具名一并带回。
                        let notification = mcp_initialized_notification();
                        let tools_req = mcp_tools_list_request();
                        let _ = stdin.write_all(notification.as_bytes()).await;
                        let _ = stdin.write_all(tools_req.as_bytes()).await;
                        let _ = stdin.flush().await;
                        continue;
                    }
                    if initialized.is_some() && body.contains("\"tools\"") {
                        let tools = extract_tool_names(body);
                        debug!(target: "mcp_probe", "stdio received tools/list count={}", tools.len());
                        if let Some(mut res) = initialized.take() {
                            res.tools = tools;
                            return Ok(res);
                        }
                    }
                }
            }
        }
        match initialized {
            Some(res) => Ok(res),
            None => Ok(ProbeResult::not_connected()),
        }
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
    let url = spec
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("http missing url")?;
    let headers: HashMap<String, String> = spec
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    debug!(target: "mcp_probe", "http probe POST {}", url);
    let client = reqwest::Client::new();
    let mut req = client
        .post(url)
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
    let not_connected = ProbeResult::not_connected();
    let resp = tokio::time::timeout(std::time::Duration::from_secs(10), req.send())
        .await
        .map_err(|_| {
            warn!(target: "mcp_probe", "http probe timeout");
            "Timed out".to_string()
        })?
        .map_err(|e| {
            warn!(target: "mcp_probe", "http probe request failed: {}", e);
            format!("Request failed: {}", e)
        })?;

    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let status = resp.status();
    let content_type = resp
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap_or("").to_string())
        .unwrap_or_default();
    debug!(target: "mcp_probe", "http probe HTTP {} content_type={}", status, content_type);
    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await
            .unwrap_or_else(|_| Ok(String::new()))
            .unwrap_or_default();
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

            // 继续握手:initialized 通知 + tools/list(流式 HTTP 每次POST独立,带上会话头)。
            let client2 = client.clone();
            let url2 = url.to_string();
            let headers2 = headers.clone();
            let tools = async move {
                let post_json = |body: serde_json::Value| {
                    let mut r = client2
                        .post(&url2)
                        .header("Accept", "application/json, text/event-stream")
                        .header("Content-Type", "application/json")
                        .json(&body);
                    for (k, v) in &headers2 {
                        r = r.header(k.as_str(), v.as_str());
                    }
                    if let Some(sid) = &session_id {
                        r = r.header("Mcp-Session-Id", sid.as_str());
                    }
                    r
                };
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    post_json(serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).send(),
                )
                .await;
                let resp = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    post_json(serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})).send(),
                )
                .await
                .ok()?
                .ok()?;
                let ct = resp
                    .headers()
                    .get("content-type")
                    .map(|v| v.to_str().unwrap_or("").to_string())
                    .unwrap_or_default();
                let text = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
                    .await
                    .ok()?
                    .ok()?;
                let json = if ct.contains("text/event-stream") {
                    text.lines().find_map(|line| {
                        let trimmed = line.trim();
                        if trimmed.starts_with("data:") && trimmed.contains("\"tools\"") {
                            trimmed.strip_prefix("data:").map(|s| s.trim())
                        } else {
                            None
                        }
                    })
                } else if text.contains("\"tools\"") {
                    Some(text.as_str())
                } else {
                    None
                }?;
                Some(extract_tool_names(json))
            };
            let tools = tokio::time::timeout(std::time::Duration::from_secs(12), tools)
                .await
                .unwrap_or(None)
                .unwrap_or_default();
            info!(target: "mcp_probe", "http probe tools count={}", tools.len());
            Ok(ProbeResult {
                connected: true,
                instructions,
                tools,
            })
        }
        None => {
            warn!(target: "mcp_probe", "http probe failed: no result in response");
            Ok(not_connected)
        }
    }
}

async fn probe_sse(spec: &serde_json::Value) -> Result<ProbeResult, String> {
    let url = spec
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("sse missing url")?;
    let headers: HashMap<String, String> = spec
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    debug!(target: "mcp_probe", "sse probe GET {}", url);
    let client = reqwest::Client::new();
    let mut req = client.get(url).header("Accept", "text/event-stream");
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(10), req.send())
        .await
        .map_err(|_| {
            warn!(target: "mcp_probe", "sse probe timeout");
            "Timed out".to_string()
        })?
        .map_err(|e| {
            warn!(target: "mcp_probe", "sse probe request failed: {}", e);
            format!("Request failed: {}", e)
        })?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap_or("").to_string())
        .unwrap_or_default();
    debug!(target: "mcp_probe", "sse probe HTTP {} content_type={}", status, content_type);

    if !status.is_success() {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), resp.text())
            .await
            .unwrap_or_else(|_| Ok(String::new()))
            .unwrap_or_default();
        warn!(target: "mcp_probe", "sse probe failed HTTP {}", status);
        return Err(format!("HTTP {} {}", status, body));
    }

    let connected =
        content_type.contains("text/event-stream") || content_type.contains("application/json");
    if connected {
        info!(target: "mcp_probe", "sse probe connected");
    } else {
        warn!(target: "mcp_probe", "sse probe failed: unexpected content type {}", content_type);
    }
    Ok(ProbeResult {
        connected,
        instructions: None,
        tools: Vec::new(),
    })
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
        let server_type = spec
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio")
            .to_string();
        debug!(target: "mcp_probe", "Queueing probe name={} type={}", name, server_type);
        handles.push(tokio::spawn(async move {
            let result = match server_type.as_str() {
                "stdio" => probe_stdio(&spec).await,
                "http" | "sse" => probe_http(&spec).await,
                _ => probe_sse(&spec).await,
            };
            let probe_result = result.unwrap_or_else(|_| ProbeResult::not_connected());
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
        let (name, probe_result) = handle
            .await
            .unwrap_or_else(|_| (String::new(), ProbeResult::not_connected()));
        if !name.is_empty() {
            results.insert(name, probe_result);
        }
    }
    let connected = results.values().filter(|r| r.connected).count();
    let total = results.len();
    info!(target: "mcp_probe", "Probe summary: {}/{} connected", connected, total);
    results
}

pub async fn probe_all_mcp_servers_impl(
    state: &AppState,
) -> Result<HashMap<String, ProbeResult>, String> {
    let servers = {
        let db = state.db.lock().unwrap();
        db::get_all_mcp_servers(&db).map_err(|e| format!("Failed to get servers: {}", e))?
    };
    Ok(probe_servers(&servers).await)
}

/// 探测一份未落库的 spec(编辑/新增时"测试连接"用)。
pub async fn probe_mcp_spec_impl(
    _state: &AppState,
    spec: serde_json::Value,
) -> Result<ProbeResult, String> {
    let server_type = spec
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio")
        .to_string();
    match server_type.as_str() {
        "stdio" => probe_stdio(&spec).await,
        "http" => probe_http(&spec).await,
        _ => probe_sse(&spec).await,
    }
}

pub async fn probe_mcp_server_impl(state: &AppState, id: String) -> Result<ProbeResult, String> {
    let server = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_mcp_server(&db, &id).map_err(|error| error.to_string())?
    }
    .ok_or_else(|| format!("Unknown MCP server: {id}"))?;

    let result = probe_servers(&[server]).await;
    let (_, probe) = result
        .into_iter()
        .next()
        .ok_or("Probe returned no result")?;
    Ok(probe)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_mcp_server_impl, get_mcp_servers_from_db, get_mcp_servers_impl, toggle_mcp_app_impl,
        upsert_mcp_server_impl,
    };
    use rusqlite::Connection;
    use std::sync::Mutex;

    #[test]
    fn get_mcp_servers_from_db_returns_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        crate::mcp::db::upsert_mcp_server(
            &conn,
            &crate::mcp::types::McpServer {
                id: "fetch".into(),
                name: "fetch".into(),
                description: "Web fetcher".into(),
                server: serde_json::json!({
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-fetch"]
                }),
                apps: crate::mcp::types::McpApps {
                    claude: true,
                    codex: false,
                    gemini: false,
                    opencode: false,
                    pi: false,
                },
                builtin: false,
                tools: Vec::new(),
            },
        )
        .unwrap();

        let db = Mutex::new(conn);

        let servers = get_mcp_servers_from_db(&db).unwrap();

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "fetch");
        assert_eq!(servers[0].description, "Web fetcher");
        assert!(!servers[0].builtin);
    }

    fn app_state() -> (tempfile::TempDir, crate::AppState) {
        let temp = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        let state = crate::AppState {
            db: Mutex::new(conn),
            config: Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: temp.path().to_path_buf(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(temp.path().to_path_buf()),
        };
        (temp, state)
    }

    #[test]
    fn list_appends_builtin_entry_and_writes_are_rejected() {
        let (_temp, state) = app_state();

        // 列表:DB 为空也追加内置条目(builtin=true,apps 全开,不落 DB)。
        let servers = get_mcp_servers_impl(&state).unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers[0].builtin);
        assert_eq!(servers[0].id, crate::builtin_mcp::SERVER_NAME);

        // 工具名由 daemon 按**当前配置**现算(内置 server 不进探测链路):全关时为空,
        // 设置页据此显示「未启用」而不是「0 个工具」。
        assert!(servers[0].tools.is_empty(), "{:?}", servers[0].tools);
        {
            let mut config = state.config.lock().unwrap();
            config.browser.enabled = true;
            config.computer_use.enabled = true;
            config.computer_use.system_execution_enabled = true;
        }
        let servers = get_mcp_servers_impl(&state).unwrap();
        assert_eq!(servers[0].tools.len(), 24, "{:?}", servers[0].tools);
        assert!(
            servers[0].apps.claude
                && servers[0].apps.codex
                && servers[0].apps.gemini
                && servers[0].apps.opencode
                && servers[0].apps.pi
        );
        // DB 里没有它:刷新/重启不产生累积。
        let db = state.db.lock().unwrap();
        assert!(
            crate::mcp::db::get_mcp_server(&db, crate::builtin_mcp::SERVER_NAME)
                .unwrap()
                .is_none()
        );
        drop(db);

        // 写入保护:upsert / delete / toggle 一律拒绝。
        let err = upsert_mcp_server_impl(
            &state,
            crate::mcp::types::McpServer {
                id: crate::builtin_mcp::SERVER_NAME.to_string(),
                name: "x".into(),
                description: String::new(),
                server: serde_json::json!({"command": "evil"}),
                apps: Default::default(),
                builtin: true,
                tools: Vec::new(),
            },
        )
        .unwrap_err();
        assert!(err.contains("不可修改或删除"));

        // 用户 server 占用内置名也拒绝。
        let err = upsert_mcp_server_impl(
            &state,
            crate::mcp::types::McpServer {
                id: "mine".into(),
                name: crate::builtin_mcp::SERVER_NAME.to_string(),
                description: String::new(),
                server: serde_json::json!({"command": "evil"}),
                apps: Default::default(),
                builtin: false,
                tools: Vec::new(),
            },
        )
        .unwrap_err();
        assert!(err.contains("名称保留"));

        let err =
            delete_mcp_server_impl(&state, crate::builtin_mcp::SERVER_NAME.into()).unwrap_err();
        assert!(err.contains("不可修改或删除"));

        let err = toggle_mcp_app_impl(
            &state,
            crate::builtin_mcp::SERVER_NAME.into(),
            "claude".into(),
            false,
        )
        .unwrap_err();
        assert!(err.contains("不可修改或删除"));

        // 正常 server 不受影响。
        upsert_mcp_server_impl(
            &state,
            crate::mcp::types::McpServer {
                id: "fetch".into(),
                name: "fetch".into(),
                description: String::new(),
                server: serde_json::json!({"command": "npx"}),
                apps: Default::default(),
                builtin: false,
                tools: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(get_mcp_servers_impl(&state).unwrap().len(), 2);

        // 历史名同样保留:用户占用它会与历史轨迹里的旧全名串味。
        let err = upsert_mcp_server_impl(
            &state,
            crate::mcp::types::McpServer {
                id: "legacy".into(),
                name: crate::builtin_mcp::LEGACY_SERVER_NAMES[0].to_string(),
                description: String::new(),
                server: serde_json::json!({"command": "evil"}),
                apps: Default::default(),
                builtin: false,
                tools: Vec::new(),
            },
        )
        .unwrap_err();
        assert!(err.contains("名称保留"));
        let err = delete_mcp_server_impl(&state, crate::builtin_mcp::LEGACY_SERVER_NAMES[0].into())
            .unwrap_err();
        assert!(err.contains("不可修改或删除"));
        assert_eq!(
            get_mcp_servers_impl(&state).unwrap().len(),
            2,
            "拒绝写入后条目数不变"
        );
    }
}
