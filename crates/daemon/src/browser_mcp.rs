//! 内置电脑控制 MCP server(`codemux-daemon mcp-browser` 子命令):会话驱动
//! 内置浏览器与桌面只读观测的唯一工具面。
//!
//! 服务名沿用 `codemux-browser`(01 票上线,改名会改掉模型侧的工具前缀
//! `mcp__codemux-browser__*`,既有权限规则与人读的日志都会失配);但按 spec
//! 「能力只暴露为一个系统内置 MCP 服务」,桌面只读工具(04 票)与后续驱动工具
//! 都挂在这一份 server 上,只读/输入的分权由 daemon 侧审批闸门(03 票)裁,
//! 不靠拆服务。
//!
//! stdio 上讲 MCP(ISO JSON-RPC 2.0,按行分帧);每个工具调用转发 daemon
//! 回环端点 `POST /api/browser-automation/execute`(Local Daemon Token 鉴权)。
//! 「开启内置浏览器控制」闸门在 daemon 端点统一裁决,本子命令不做二次判断。
//!
//! 发现:`--app-data-dir`(必填)→ `daemon-run-state.json` 取端口(daemon
//! 必须在运行),`local-daemon-token` 取令牌(与壳/CLI 同源)。
//!
//! 本文件不含 I/O 以外的环境假设;JSON-RPC 应答为纯函数,便于单测。

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::companion::local_daemon_token;
use crate::daemon::{run_state, DAEMON_VERSION};

/// 内置 server 名(会话命令 `mcpServers` 的键)。
pub const BROWSER_MCP_SERVER_NAME: &str = "codemux-browser";

/// 单次 execute 转发的等待上限。
///
/// 覆盖 daemon 端「人工审批等待(默认 120s)+ 壳执行(15s)」两级:审批是
/// 面向人的,客户端必须比它等得久,否则用户还没点就被判定超时。
const EXECUTE_TIMEOUT: Duration = Duration::from_secs(180);

/// 会话命令注入用的内置 server spec(stdio 指向本 daemon 二进制子命令)。
pub fn builtin_server_spec(current_exe: &Path, app_data_dir: &Path) -> Value {
    json!({
        "command": current_exe.to_string_lossy(),
        "args": ["mcp-browser", "--app-data-dir", app_data_dir.to_string_lossy()],
    })
}

/// 带会话归属的 spec(会话命令注入用):审批与审计按会话落账。
pub fn builtin_server_spec_for_session(
    current_exe: &Path,
    app_data_dir: &Path,
    session_id: &str,
) -> Value {
    json!({
        "command": current_exe.to_string_lossy(),
        "args": [
            "mcp-browser",
            "--app-data-dir", app_data_dir.to_string_lossy(),
            "--session-id", session_id,
        ],
    })
}

/// MCP 设置页展示用的内置条目(不在 DB,列表 API 动态追加;写入路径按
/// id/name 拒绝改删)。apps 全开:注入侧按 runtime 会话命令分发。
pub fn builtin_server_entry(
    current_exe: &Path,
    app_data_dir: &Path,
) -> crate::mcp::types::McpServer {
    crate::mcp::types::McpServer {
        id: BROWSER_MCP_SERVER_NAME.to_string(),
        name: BROWSER_MCP_SERVER_NAME.to_string(),
        description: "内置电脑控制:浏览器级(列表、求值、截图、键鼠输入、CDP、快照、元素点击、输入、滚动、选择)与桌面只读观测(窗口清单、桌面截图、活动窗口)。浏览器级随「浏览器控制」开关,桌面只读随「电脑控制」开关;内置提供,不可修改或删除。".to_string(),
        server: builtin_server_spec(current_exe, app_data_dir),
        apps: crate::mcp::types::McpApps {
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            pi: true,
        },
        builtin: true,
    }
}

/// daemon 回环地址 + Local Daemon Token(execute 转发所需的最小环境)。
///
/// 构造不做 I/O:daemon 没在跑时也要能应答 `initialize` / `tools/list`,
/// 否则智能体连工具面都看不到,只能看见一个起不来的 server。端口与令牌在
/// 每次转发时现取 —— daemon 重启换端口后自动跟上。
pub struct BrowserMcpRuntime {
    app_data_dir: PathBuf,
    /// 端口覆盖(测试/调试;None = 读 run-state)。
    port_override: Option<u16>,
    /// 令牌覆盖(测试;None = 读/建 app-data-dir 下的本地令牌)。
    token_override: Option<String>,
    http: reqwest::Client,
    /// 会话归属(会话命令经 `--session-id` 注入;手工直连时为 None)。
    session_id: Option<String>,
}

impl BrowserMcpRuntime {
    pub fn new(
        app_data_dir: &Path,
        port_override: Option<u16>,
        session_id: Option<String>,
    ) -> Self {
        Self {
            app_data_dir: app_data_dir.to_path_buf(),
            port_override,
            token_override: None,
            http: reqwest::Client::builder()
                .timeout(EXECUTE_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            session_id,
        }
    }

    /// 现取 daemon 端口与本地令牌;每一步失败都给面向模型的明确文案。
    fn endpoint(&self) -> Result<(u16, String), String> {
        let port = match self.port_override {
            Some(port) => port,
            None => {
                let roots = crate::paths::PathRoots {
                    app_data_dir: self.app_data_dir.clone(),
                    resource_dir: None,
                };
                run_state::read(&roots)
                    .ok_or_else(|| {
                        "未发现运行中的 daemon(daemon-run-state.json 缺失或已过期)".to_string()
                    })?
                    .port
            }
        };
        let token = match &self.token_override {
            Some(token) => token.clone(),
            None => local_daemon_token::ensure_local_daemon_token(&self.app_data_dir, false)?,
        };
        Ok((port, token))
    }

    /// 转发一次 execute;成功返回 payload,失败(4xx/5xx/网络)返回面向
    /// 模型的错误文案(daemon 的 403 文案原样透传)。
    pub async fn call_execute(
        &self,
        tool: &str,
        op: &str,
        browser_id: Option<&str>,
        params: Value,
    ) -> Result<Value, String> {
        let (port, token) = self.endpoint()?;
        let response = self
            .http
            .post(format!(
                "http://127.0.0.1:{}/api/browser-automation/execute",
                port
            ))
            .bearer_auth(&token)
            .json(&json!({
                "op": op,
                "browserId": browser_id,
                "params": params,
                "tool": tool,
                "sessionId": self.session_id,
            }))
            .send()
            .await
            .map_err(|e| format!("连接 daemon 失败: {}", e))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("daemon 响应解析失败: {}", e))?;
        match status {
            reqwest::StatusCode::OK => Ok(body["payload"].clone()),
            _ => Err(body["error"]
                .as_str()
                .unwrap_or("浏览器自动化请求失败")
                .to_string()),
        }
    }
}

/// 工具清单(与 `AUTOMATION_OPS` 的 op 面一一对应;描述面向模型)。
fn tool_definitions() -> Value {
    json!([
        {
            "name": "browser_list",
            "description": "列出内置浏览器当前打开的页面(browserId/URL/标题)。操作其他浏览器工具前先调用它确定目标。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "browser_eval",
            "description": "在内置浏览器页面中执行 JavaScript 并返回 JSON 结果。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "要执行的 JavaScript 代码" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["code"],
            },
        },
        {
            "name": "browser_screenshot",
            "description": "对内置浏览器页面截屏,返回 PNG 图像。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
            },
        },
        {
            "name": "browser_input",
            "description": "向内置浏览器页面注入受信键盘/鼠标事件(Electron InputEvent 字段:type、x、y、keyCode 等)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "event": { "type": "object", "description": "InputEvent 字段面" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["event"],
            },
        },
        {
            "name": "browser_cdp",
            "description": "对内置浏览器页面执行一条 Chrome DevTools Protocol 命令(高级操作逃生舱)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string", "description": "CDP 方法名,如 DOM.getDocument" },
                    "params": { "type": "object", "description": "CDP 命令参数" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["method"],
            },
        },
        {
            "name": "browser_snapshot",
            "description": "读取当前浏览器页的结构化快照：可交互元素列表（含编号、角色、名称与包围盒）与视口尺寸；截图随结果以图片形式返回。用元素编号驱动后续点击、输入等操作。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "browserId": { "type": "string", "description": "目标页面；省略时取最近打开的页面" },
                },
            },
        },
        {
            "name": "browser_click",
            "description": "点击快照中的元素（按元素编号，如 e3）；先调 browser_snapshot 拿最新列表。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "button": { "type": "string", "description": "left、middle 或 right，缺省 left" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId"],
            },
        },
        {
            "name": "browser_type",
            "description": "在快照中的元素里输入文字（按元素编号）；聚焦后设值并派发输入事件，submit 为真且在表单内时提交。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "text": { "type": "string" },
                    "submit": { "type": "boolean" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId", "text"],
            },
        },
        {
            "name": "browser_scroll",
            "description": "滚动页面或快照中的元素：无元素编号时按增量滚屏，有编号时在元素中心滚轮。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "deltaX": { "type": "number" },
                    "deltaY": { "type": "number" },
                    "browserId": { "type": "string" },
                },
            },
        },
        {
            "name": "browser_select",
            "description": "在快照中的下拉框元素里按值选择（按元素编号），选择后派发变更事件。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "value": { "type": "string" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId", "value"],
            },
        },
        {
            "name": "computer_windows",
            "description": "列出桌面上的屏幕与窗口(来源 id 与标题)。只读,不改动任何窗口。截取某个窗口前先用它取 sourceId。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "computer_screenshot",
            "description": "截取桌面画面(默认主屏,可指定 computer_windows 给出来源 id)。只读;返回图片。窗口最小化或已关闭时返回错误。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sourceId": { "type": "string", "description": "computer_windows 返回的来源 id;省略时截主屏" },
                },
            },
        },
        {
            "name": "computer_active_window",
            "description": "读取当前前台窗口(标题、进程、位置,以及可用于截图的来源 id)。读不到时明确报错,不会拿别的窗口冒充。",
            "inputSchema": { "type": "object", "properties": {} },
        },
    ])
}

/// 一次 stdio 请求的应答(纯函数,便于单测):`Ok(None)` 表示通知,不应答。
pub fn handle_request<'a>(
    runtime: &'a BrowserMcpRuntime,
    method: &'a str,
    params: &'a Value,
) -> impl std::future::Future<Output = Result<Value, (i64, String)>> + 'a {
    let method = method.to_string();
    let params = params.clone();
    async move {
        match method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": BROWSER_MCP_SERVER_NAME,
                    "version": DAEMON_VERSION,
                },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or_default();
                let args = params["arguments"].as_object().cloned().unwrap_or_default();
                call_tool(runtime, name, &args).await
            }
            other => Err((
                -32601,
                format!(
                    "Method not found: {}(内置浏览器 server 仅支持 initialize/ping/tools/*)",
                    other
                ),
            )),
        }
    }
}

/// 工具调用 → execute 转发;返回 MCP content 数组(失败置 isError)。
async fn call_tool(
    runtime: &BrowserMcpRuntime,
    name: &str,
    args: &serde_json::Map<String, Value>,
) -> Result<Value, (i64, String)> {
    let browser_id = args.get("browserId").and_then(|v| v.as_str());
    let result: Result<Value, String> = match name {
        "browser_list" => runtime.call_execute(name, "list", None, json!({})).await,
        "browser_eval" => match args.get("code").and_then(|v| v.as_str()) {
            Some(code) if !code.trim().is_empty() => {
                runtime
                    .call_execute(name, "eval", browser_id, json!({ "code": code }))
                    .await
            }
            _ => Err("browser_eval 缺少必填参数 code".to_string()),
        },
        "browser_screenshot" => {
            runtime
                .call_execute(name, "screenshot", browser_id, json!({}))
                .await
        }
        "browser_input" => match args.get("event") {
            Some(event) if event.is_object() => {
                runtime
                    .call_execute(name, "input", browser_id, event.clone())
                    .await
            }
            _ => Err("browser_input 缺少必填参数 event(对象)".to_string()),
        },
        "browser_cdp" => match args.get("method").and_then(|v| v.as_str()) {
            Some(method) if !method.trim().is_empty() => {
                runtime
                    .call_execute(
                        name,
                        "cdp",
                        browser_id,
                        json!({ "method": method, "params": args.get("params") }),
                    )
                    .await
            }
            _ => Err("browser_cdp 缺少必填参数 method".to_string()),
        },
        "browser_snapshot" => {
            runtime
                .call_execute(name, "snapshot", browser_id, json!({}))
                .await
        }
        "browser_click" => match args.get("elementId").and_then(|v| v.as_str()) {
            Some(element_id) if !element_id.trim().is_empty() => {
                runtime
                    .call_execute(
                        name,
                        "click",
                        browser_id,
                        json!({ "elementId": element_id }),
                    )
                    .await
            }
            _ => Err("browser_click 缺少必填参数 elementId".to_string()),
        },
        "browser_type" => {
            let element_id = args.get("elementId").and_then(|v| v.as_str()).unwrap_or("");
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if element_id.trim().is_empty() || text.is_empty() {
                Err("browser_type 缺少必填参数 elementId 或 text".to_string())
            } else {
                let mut params = serde_json::Map::new();
                params.insert(
                    "elementId".to_string(),
                    Value::String(element_id.to_string()),
                );
                params.insert("text".to_string(), Value::String(text.to_string()));
                if let Some(submit) = args.get("submit") {
                    params.insert("submit".to_string(), submit.clone());
                }
                runtime
                    .call_execute(name, "type", browser_id, Value::Object(params))
                    .await
            }
        }
        "browser_scroll" => {
            let mut params = serde_json::Map::new();
            for key in ["elementId", "deltaX", "deltaY"] {
                if let Some(value) = args.get(key) {
                    params.insert(key.to_string(), value.clone());
                }
            }
            runtime
                .call_execute(name, "scroll", browser_id, Value::Object(params))
                .await
        }
        "browser_select" => {
            let element_id = args.get("elementId").and_then(|v| v.as_str()).unwrap_or("");
            let value = args.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if element_id.trim().is_empty() || value.is_empty() {
                Err("browser_select 缺少必填参数 elementId 或 value".to_string())
            } else {
                runtime
                    .call_execute(
                        name,
                        "select",
                        browser_id,
                        json!({ "elementId": element_id, "value": value }),
                    )
                    .await
            }
        }
        "computer_windows" => {
            runtime
                .call_execute(name, "desktop-windows", None, json!({}))
                .await
        }
        "computer_screenshot" => {
            let mut params = serde_json::Map::new();
            if let Some(source_id) = args.get("sourceId") {
                params.insert("sourceId".to_string(), source_id.clone());
            }
            runtime
                .call_execute(name, "desktop-screenshot", None, Value::Object(params))
                .await
        }
        "computer_active_window" => {
            runtime
                .call_execute(name, "desktop-active-window", None, json!({}))
                .await
        }
        other => Err(format!("未知工具: {}(见 tools/list)", other)),
    };
    Ok(match result {
        Ok(payload) => match (name, payload) {
            ("browser_snapshot", Value::Object(map)) => {
                let screenshot = map.get("screenshot").and_then(|v| v.as_str()).unwrap_or("");
                let mut summary = map.clone();
                summary.remove("screenshot");
                json!({
                    "content": [
                        { "type": "image", "data": screenshot, "mimeType": "image/png" },
                        { "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "null".to_string()) },
                    ],
                })
            }
            ("browser_screenshot", Value::String(data)) if !data.is_empty() => json!({
                "content": [{ "type": "image", "data": data, "mimeType": "image/png" }],
            }),
            ("computer_screenshot", Value::Object(map)) => {
                let image = map.get("image").and_then(|v| v.as_str()).unwrap_or("");
                if image.is_empty() {
                    json!({
                        "content": [{ "type": "text", "text": "桌面截图为空(来源可能已关闭或最小化)" }],
                        "isError": true,
                    })
                } else {
                    let mut meta = map.clone();
                    meta.remove("image");
                    json!({
                        "content": [
                            { "type": "image", "data": image, "mimeType": "image/png" },
                            { "type": "text", "text": serde_json::to_string_pretty(&meta).unwrap_or_else(|_| "null".to_string()) },
                        ],
                    })
                }
            }
            ("browser_eval", payload) => json!({
                "content": [{ "type": "text", "text": payload.as_str().unwrap_or("null") }],
            }),
            (_, payload) => json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "null".to_string()) }],
            }),
        },
        Err(error) => json!({
            "content": [{ "type": "text", "text": error }],
            "isError": true,
        }),
    })
}

/// stdio 主循环:按行读 JSON-RPC,应答写 stdout(逐行 flush)。EOF 或致命
/// 写错误返回。永不因单条坏行失败 —— 坏行回 -32700(id null)。
pub fn run_stdio(runtime: &BrowserMcpRuntime) -> Result<(), String> {
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("构建 tokio 运行时失败: {}", e))?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("读取 stdin 失败: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => {
                let Some(id) = message.get("id").cloned() else {
                    // 通知(如 notifications/initialized):不应答。
                    continue;
                };
                let method = message["method"].as_str().unwrap_or_default().to_string();
                let params = message.get("params").cloned().unwrap_or(json!({}));
                match tokio_runtime.block_on(handle_request(runtime, &method, &params)) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err((code, message_text)) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": code, "message": message_text },
                    }),
                }
            }
            Err(_) => json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error: 请求不是合法 JSON" },
            }),
        };
        writeln!(stdout, "{}", response).map_err(|e| format!("写出 stdout 失败: {}", e))?;
        stdout
            .flush()
            .map_err(|e| format!("刷新 stdout 失败: {}", e))?;
    }
    Ok(())
}

/// 子命令入口:`codemux-daemon mcp-browser --app-data-dir <dir> [--port <n>]
/// [--session-id <id>]`。
pub fn run_subcommand(
    app_data_dir: PathBuf,
    port_override: Option<u16>,
    session_id: Option<String>,
) -> Result<(), String> {
    let runtime = BrowserMcpRuntime::new(&app_data_dir, port_override, session_id);
    run_stdio(&runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_at(port: u16) -> BrowserMcpRuntime {
        BrowserMcpRuntime {
            app_data_dir: std::env::temp_dir(),
            port_override: Some(port),
            token_override: Some("test-token".to_string()),
            http: reqwest::Client::new(),
            session_id: Some("session-test".to_string()),
        }
    }

    #[test]
    fn builtin_spec_points_at_daemon_subcommand() {
        let spec =
            builtin_server_spec(Path::new("C:/bin/codemux-daemon.exe"), Path::new("D:/data"));
        assert_eq!(spec["command"], "C:/bin/codemux-daemon.exe");
        assert_eq!(spec["args"][0], "mcp-browser");
        assert_eq!(spec["args"][1], "--app-data-dir");
        assert_eq!(spec["args"][2], "D:/data");
    }

    #[tokio::test]
    async fn initialize_echoes_protocol_version() {
        let runtime = runtime_at(1);
        let result = handle_request(
            &runtime,
            "initialize",
            &json!({ "protocolVersion": "2025-06-18" }),
        )
        .await
        .expect("initialize 应成功");
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"]["name"], BROWSER_MCP_SERVER_NAME);
        assert_eq!(result["capabilities"]["tools"], json!({}));
    }

    #[tokio::test]
    async fn tools_list_covers_all_execute_ops() {
        let runtime = runtime_at(1);
        let result = handle_request(&runtime, "tools/list", &json!({}))
            .await
            .expect("tools/list 应成功");
        let names: Vec<&str> = result["tools"]
            .as_array()
            .expect("tools 数组")
            .iter()
            .map(|tool| tool["name"].as_str().expect("工具名"))
            .collect();
        assert_eq!(
            names,
            [
                "browser_list",
                "browser_eval",
                "browser_screenshot",
                "browser_input",
                "browser_cdp",
                "browser_snapshot",
                "browser_click",
                "browser_type",
                "browser_scroll",
                "browser_select",
                "computer_windows",
                "computer_screenshot",
                "computer_active_window",
            ]
        );
        // 工具面覆盖全部 op 面:每个合法 op 至少有一个工具能到达它(01 票的
        // 一一对应在 04 票加了桌面只读三件套,这里按「覆盖」而非「同名」断言)。
        let ops_reachable = [
            "list",
            "eval",
            "screenshot",
            "input",
            "cdp",
            "snapshot",
            "click",
            "type",
            "scroll",
            "select",
            "desktop-windows",
            "desktop-screenshot",
            "desktop-active-window",
        ];
        assert_eq!(
            ops_reachable.len(),
            crate::companion::browser_automation::AUTOMATION_OPS.len(),
            "新增 op 时同步补工具或更新本断言"
        );
    }

    #[test]
    fn desktop_tools_are_mapped_to_desktop_ops() {
        // 三个桌面只读工具的存在与分类:只读由 daemon 闸门按 op 裁决。
        for op in crate::companion::browser_automation::DESKTOP_OPS {
            assert!(
                crate::companion::browser_automation::is_desktop_op(op),
                "{op} 应被识别为桌面只读操作"
            );
        }
        assert!(!crate::companion::browser_automation::is_desktop_op(
            "snapshot"
        ));
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let runtime = runtime_at(1);
        let (code, message) = handle_request(&runtime, "resources/list", &json!({}))
            .await
            .expect_err("未知方法必须 -32601");
        assert_eq!(code, -32601);
        assert!(message.contains("resources/list"));
    }

    #[tokio::test]
    async fn missing_required_args_fail_without_network() {
        let runtime = runtime_at(1);
        for (name, args) in [
            ("browser_eval", json!({})),
            ("browser_input", json!({ "event": "not-object" })),
            ("browser_cdp", json!({})),
            ("browser_click", json!({})),
            ("browser_type", json!({"elementId": "e1"})),
            ("browser_select", json!({"elementId": "e1"})),
        ] {
            let result = handle_request(
                &runtime,
                "tools/call",
                &json!({ "name": name, "arguments": args }),
            )
            .await
            .expect("tools/call 应答");
            assert_eq!(result["isError"], true, "{} 缺参应 isError", name);
        }
        let unknown = handle_request(
            &runtime,
            "tools/call",
            &json!({ "name": "browser_fly", "arguments": {} }),
        )
        .await
        .expect("tools/call 应答");
        assert!(unknown["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("未知工具"));
    }

    #[tokio::test]
    async fn failed_execute_becomes_is_error_content() {
        // 端口 1 上没有 daemon:连接失败 → isError,错误文案含原因。
        let runtime = runtime_at(1);
        let result = handle_request(
            &runtime,
            "tools/call",
            &json!({ "name": "browser_list", "arguments": {} }),
        )
        .await
        .expect("tools/call 应答");
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("连接 daemon 失败"));
    }
}
