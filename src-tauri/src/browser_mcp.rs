//! 内置浏览器 MCP server(`codemux-daemon mcp-browser` 子命令):会话驱动
//! 内置浏览器的工具面。
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

/// 单次 execute 转发的等待上限(daemon 端等待壳回包默认 15s,此处放宽收口)。
const EXECUTE_TIMEOUT: Duration = Duration::from_secs(20);

/// 会话命令注入用的内置 server spec(stdio 指向本 daemon 二进制子命令)。
pub fn builtin_server_spec(current_exe: &Path, app_data_dir: &Path) -> Value {
    json!({
        "command": current_exe.to_string_lossy(),
        "args": ["mcp-browser", "--app-data-dir", app_data_dir.to_string_lossy()],
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
        description: "内置浏览器控制:让会话驱动内置浏览器(eval / 截图 / 输入 / CDP)。随「设置 → 浏览器控制」开关生效,内置提供,不可修改或删除。".to_string(),
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
pub struct BrowserMcpRuntime {
    port: u16,
    token: String,
    http: reqwest::Client,
}

impl BrowserMcpRuntime {
    /// 从 app-data-dir 发现端口与令牌;`port_override` 供测试/调试直连。
    pub fn discover(app_data_dir: &Path, port_override: Option<u16>) -> Result<Self, String> {
        let port = match port_override {
            Some(port) => port,
            None => {
                let roots = crate::paths::PathRoots {
                    app_data_dir: app_data_dir.to_path_buf(),
                    resource_dir: None,
                };
                run_state::read(&roots)
                    .ok_or_else(|| {
                        "未发现运行中的 daemon(daemon-run-state.json 缺失或已过期)".to_string()
                    })?
                    .port
            }
        };
        let token = local_daemon_token::ensure_local_daemon_token(app_data_dir, false)?;
        let http = reqwest::Client::builder()
            .timeout(EXECUTE_TIMEOUT)
            .build()
            .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
        Ok(Self { port, token, http })
    }

    /// 转发一次 execute;成功返回 payload,失败(4xx/5xx/网络)返回面向
    /// 模型的错误文案(daemon 的 403 文案原样透传)。
    pub async fn call_execute(
        &self,
        op: &str,
        browser_id: Option<&str>,
        params: Value,
    ) -> Result<Value, String> {
        let response = self
            .http
            .post(format!(
                "http://127.0.0.1:{}/api/browser-automation/execute",
                self.port
            ))
            .bearer_auth(&self.token)
            .json(&json!({ "op": op, "browserId": browser_id, "params": params }))
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
        "browser_list" => runtime.call_execute("list", None, json!({})).await,
        "browser_eval" => match args.get("code").and_then(|v| v.as_str()) {
            Some(code) if !code.trim().is_empty() => {
                runtime
                    .call_execute("eval", browser_id, json!({ "code": code }))
                    .await
            }
            _ => Err("browser_eval 缺少必填参数 code".to_string()),
        },
        "browser_screenshot" => {
            runtime
                .call_execute("screenshot", browser_id, json!({}))
                .await
        }
        "browser_input" => match args.get("event") {
            Some(event) if event.is_object() => {
                runtime
                    .call_execute("input", browser_id, event.clone())
                    .await
            }
            _ => Err("browser_input 缺少必填参数 event(对象)".to_string()),
        },
        "browser_cdp" => match args.get("method").and_then(|v| v.as_str()) {
            Some(method) if !method.trim().is_empty() => {
                runtime
                    .call_execute(
                        "cdp",
                        browser_id,
                        json!({ "method": method, "params": args.get("params") }),
                    )
                    .await
            }
            _ => Err("browser_cdp 缺少必填参数 method".to_string()),
        },
        other => Err(format!("未知工具: {}(见 tools/list)", other)),
    };
    Ok(match result {
        Ok(payload) => match (name, payload) {
            ("browser_screenshot", Value::String(data)) if !data.is_empty() => json!({
                "content": [{ "type": "image", "data": data, "mimeType": "image/png" }],
            }),
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

/// 子命令入口:`codemux-daemon mcp-browser --app-data-dir <dir> [--port <n>]`。
pub fn run_subcommand(app_data_dir: PathBuf, port_override: Option<u16>) -> Result<(), String> {
    let runtime = BrowserMcpRuntime::discover(&app_data_dir, port_override)?;
    run_stdio(&runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_at(port: u16) -> BrowserMcpRuntime {
        BrowserMcpRuntime {
            port,
            token: "test-token".to_string(),
            http: reqwest::Client::new(),
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
                "browser_cdp"
            ]
        );
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
