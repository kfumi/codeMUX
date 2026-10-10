//! 电脑控制驱动宿主(工单 05):daemon 拉起独立驱动子进程,经标准输入输出讲 MCP。
//!
//! 为什么是子进程而不是库:驱动要碰系统键鼠,崩溃与权限问题都该被关在独立
//! 进程里;`kill_on_drop` + 急停取走句柄即杀进程,进程级刹车不依赖驱动配合。
//!
//! 协议面与内置 server 同形(按行 JSON-RPC 2.0):`initialize` →
//! `notifications/initialized` → `tools/list` → 逐个 `tools/call`。驱动可以是
//! 任何讲 MCP 的 stdio 程序(cua-driver 之类的外部实现,或概念验证时拿
//! `codemux-daemon mcp-control` 顶替)。
//!
//! 本模块的协议解析是纯函数;真正拉起子进程的部分由集成测试用真实二进制覆盖
//! (`tests/computer_use_driver.rs`)。

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Notify};

/// 一次握手的等待上限。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

/// 单次工具调用的等待上限。
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// 驱动启动方式(来自 `computer_use.driver_command` / `driver_args`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverSpec {
    pub command: String,
    pub args: Vec<String>,
}

impl DriverSpec {
    pub fn new(command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
        }
    }
}

/// 驱动运行态(设置页与诊断共用)。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub configured: bool,
    pub running: bool,
    pub command: Option<String>,
    pub server_name: Option<String>,
    pub version: Option<String>,
    pub tools: Vec<String>,
    pub last_error: Option<String>,
}

/// 一行应答的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseLine {
    /// 与请求 id 对应的结果。
    Result(Value),
    /// 与请求 id 对应的 JSON-RPC 错误。
    Error(String),
    /// 通知、别的 id、或解析不出 JSON —— 都不是本次请求的应答,跳过。
    Ignore,
}

/// 解析一行 stdio 应答(纯函数)。
pub fn parse_response_line(line: &str, expected_id: u64) -> ResponseLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ResponseLine::Ignore;
    };
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        // 通知没有 id。
        return ResponseLine::Ignore;
    };
    if id != expected_id {
        return ResponseLine::Ignore;
    }
    match value.get("error") {
        Some(error) if !error.is_null() => {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("驱动返回错误");
            ResponseLine::Error(message.to_string())
        }
        _ => ResponseLine::Result(value.get("result").cloned().unwrap_or(Value::Null)),
    }
}

/// 从 `tools/list` 结果里取工具名清单(纯函数)。
pub fn tool_names(tools_list: &Value) -> Vec<String> {
    tools_list
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 驱动子进程句柄。
struct DriverProcess {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    server_name: Option<String>,
    version: Option<String>,
    tools: Vec<String>,
    /// 下一个 JSON-RPC 请求 id(握手用了 1、2,从 3 起)。
    last_id: u64,
}

/// 驱动宿主:串行持有子进程 + 急停信号。
pub struct DriverHost {
    process: Mutex<Option<DriverProcess>>,
    stopping: AtomicBool,
    kill_signal: Notify,
    last_error: StdMutex<Option<String>>,
}

impl Default for DriverHost {
    fn default() -> Self {
        Self::new()
    }
}

impl DriverHost {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            stopping: AtomicBool::new(false),
            kill_signal: Notify::new(),
            last_error: StdMutex::new(None),
        }
    }

    fn set_last_error(&self, error: Option<String>) {
        *self.last_error.lock().expect("driver error lock") = error;
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().expect("driver error lock").clone()
    }

    /// 是否正在运行(子进程句柄在手且未被急停)。
    pub async fn is_running(&self) -> bool {
        self.process.lock().await.is_some() && !self.stopping.load(Ordering::SeqCst)
    }

    /// 驱动子进程的 pid(未运行 = `None`)。桌面只读回包筛查(工单 11)据此
    /// 拒绝驱动自己的窗口(比如它的状态面板)。
    pub async fn pid(&self) -> Option<u32> {
        let guard = self.process.lock().await;
        guard.as_ref().and_then(|process| process.child.id())
    }

    /// 状态快照(设置页诊断与 UI 用);不主动拉起进程。
    ///
    /// 规格每次由调用方从配置传入 —— 配置是唯一事实来源,不存在「改了配置
    /// 但宿主还拿着旧命令」的错位。
    pub async fn status(&self, spec: Option<&DriverSpec>) -> DriverStatus {
        let spec = spec.cloned();
        let guard = self.process.lock().await;
        match guard.as_ref() {
            Some(process) => DriverStatus {
                configured: spec.is_some(),
                running: !self.stopping.load(Ordering::SeqCst),
                command: spec.map(|spec| spec.command),
                server_name: process.server_name.clone(),
                version: process.version.clone(),
                tools: process.tools.clone(),
                last_error: self.last_error(),
            },
            None => DriverStatus {
                configured: spec.is_some(),
                running: false,
                command: spec.map(|spec| spec.command),
                server_name: None,
                version: None,
                tools: Vec::new(),
                last_error: self.last_error(),
            },
        }
    }

    /// 拉起驱动并完成 MCP 握手;已运行则直接返回当前状态。
    pub async fn start(&self, spec: Option<&DriverSpec>) -> Result<DriverStatus, String> {
        {
            let mut guard = self.process.lock().await;
            if guard.is_some() && !self.stopping.load(Ordering::SeqCst) {
                drop(guard);
                return Ok(self.status(spec).await);
            }
            // 急停后的重启:清标志再重新拉起。
            self.stopping.store(false, Ordering::SeqCst);
            *guard = None;
        }
        let spec = spec
            .cloned()
            .ok_or_else(|| {
                "未检测到 cua-driver(官方安装位置与 PATH 都没有):可点「一键安装」,或在 设置 → 电脑控制 → 驱动命令 手动填写"
                    .to_string()
            })?;

        let mut child = match Command::new(&spec.command)
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 急停取走句柄即杀进程:进程级刹车不依赖驱动配合。
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let message = format!("拉起驱动失败({}): {}", spec.command, error);
                // 失败原因留在状态里:设置页的诊断要能直接展示它。
                self.set_last_error(Some(message.clone()));
                return Err(message);
            }
        };

        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let message = "驱动 stdio 不可用(无法建立 MCP 通道)".to_string();
            self.set_last_error(Some(message.clone()));
            return Err(message);
        };

        let mut process = DriverProcess {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            server_name: None,
            version: None,
            tools: Vec::new(),
            last_id: 2,
        };

        let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut process)).await;
        match handshake {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.set_last_error(Some(error.clone()));
                drop(process);
                return Err(error);
            }
            Err(_) => {
                let error = format!("驱动握手超时({}s)", HANDSHAKE_TIMEOUT.as_secs());
                self.set_last_error(Some(error.clone()));
                drop(process);
                return Err(error);
            }
        }

        self.set_last_error(None);
        *self.process.lock().await = Some(process);
        Ok(self.status(Some(&spec)).await)
    }

    /// 转发一次工具调用;驱动未运行时明确报错(不静默)。
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err("驱动已急停:先重新启动驱动再操作".to_string());
        }
        let mut guard = self.process.lock().await;
        let Some(process) = guard.as_mut() else {
            return Err("驱动未运行:请先在 设置 → 电脑控制 中启动驱动".to_string());
        };

        let request = json!({
            "jsonrpc": "2.0",
            "id": process.next_id(),
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        let id = request["id"].as_u64().unwrap_or_default();

        let outcome = tokio::select! {
            result = tokio::time::timeout(CALL_TIMEOUT, request_response(process, &request, id)) => {
                match result {
                    Ok(result) => result,
                    Err(_) => Err(format!("驱动调用超时({}s)", CALL_TIMEOUT.as_secs())),
                }
            }
            _ = self.kill_signal.notified() => Err("驱动已急停".to_string()),
        };
        if let Err(error) = &outcome {
            self.set_last_error(Some(error.clone()));
        }
        outcome
    }

    /// 急停:置停标志、唤醒在途调用、取走并丢弃句柄(kill_on_drop 杀进程)。
    ///
    /// 返回是否真的有进程被杀。
    pub async fn estop(&self) -> bool {
        self.stopping.store(true, Ordering::SeqCst);
        self.kill_signal.notify_waiters();
        let mut guard = self.process.lock().await;
        let taken = guard.take();
        if let Some(mut process) = taken {
            let _ = process.child.kill().await;
            self.set_last_error(Some("已急停:驱动子进程被杀".to_string()));
            true
        } else {
            false
        }
    }
}

impl DriverProcess {
    fn next_id(&mut self) -> u64 {
        self.last_id += 1;
        self.last_id
    }
}

async fn write_request(process: &mut DriverProcess, request: &Value) -> Result<u64, String> {
    let id = request["id"].as_u64().unwrap_or_default();
    let mut line = serde_json::to_string(request).map_err(|error| error.to_string())?;
    line.push('\n');
    process
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("写入驱动失败: {}", error))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|error| format!("刷新驱动 stdin 失败: {}", error))?;
    Ok(id)
}

/// 发出请求并读到对应 id 的应答(跳过通知与其他 id)。
async fn request_response(
    process: &mut DriverProcess,
    request: &Value,
    id: u64,
) -> Result<Value, String> {
    let _ = write_request(process, request).await?;
    read_response(process, id).await
}

async fn read_response(process: &mut DriverProcess, id: u64) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = process
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("读取驱动输出失败: {}", error))?;
        if read == 0 {
            return Err("驱动进程已退出(stdio 关闭)".to_string());
        }
        match parse_response_line(&line, id) {
            ResponseLine::Result(result) => return Ok(result),
            ResponseLine::Error(message) => return Err(format!("驱动返回错误: {message}")),
            ResponseLine::Ignore => continue,
        }
    }
}

/// 握手:initialize → notifications/initialized → tools/list。
async fn handshake(process: &mut DriverProcess) -> Result<(), String> {
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "codemux-daemon", "version": crate::daemon::DAEMON_VERSION },
        },
    });
    let result = request_response(process, &initialize, 1).await?;
    process.server_name = result
        .get("serverInfo")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    process.version = result
        .get("serverInfo")
        .and_then(|info| info.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let mut line = serde_json::to_string(&initialized).map_err(|error| error.to_string())?;
    line.push('\n');
    process
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("写入驱动失败: {}", error))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|error| format!("刷新驱动 stdin 失败: {}", error))?;

    let tools_request = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
    let tools = request_response(process, &tools_request, 2).await?;
    process.tools = tool_names(&tools);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> DriverSpec {
        DriverSpec::new("cua-driver", vec!["--stdio".to_string()])
    }

    #[test]
    fn response_lines_are_matched_by_id() {
        assert_eq!(
            parse_response_line(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#, 7),
            ResponseLine::Result(json!({ "ok": true }))
        );
        assert_eq!(
            parse_response_line(r#"{"jsonrpc":"2.0","id":8,"result":{}}"#, 7),
            ResponseLine::Ignore,
            "别的 id 不是本次应答"
        );
        assert_eq!(
            parse_response_line(r#"{"jsonrpc":"2.0","method":"notifications/progress"}"#, 7),
            ResponseLine::Ignore,
            "通知没有 id"
        );
        assert_eq!(parse_response_line("不是 JSON", 7), ResponseLine::Ignore);
    }

    #[test]
    fn jsonrpc_errors_surface_as_messages() {
        let line =
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}"#;
        assert_eq!(
            parse_response_line(line, 3),
            ResponseLine::Error("Method not found".to_string())
        );
    }

    #[test]
    fn tool_names_reads_the_tools_array() {
        let list =
            json!({ "tools": [{ "name": "click" }, { "name": "screenshot" }, { "no": "name" }] });
        assert_eq!(tool_names(&list), vec!["click", "screenshot"]);
        assert!(tool_names(&json!({})).is_empty());
    }

    #[tokio::test]
    async fn status_is_empty_before_first_start() {
        let host = DriverHost::new();
        let status = host.status(None).await;
        assert!(!status.configured);
        assert!(!status.running);
        assert!(status.command.is_none());
        assert!(status.tools.is_empty());
        assert!(!host.is_running().await);
    }

    #[tokio::test]
    async fn call_without_start_reports_a_clear_error() {
        let host = DriverHost::new();
        let error = host
            .call_tool("click", json!({}))
            .await
            .expect_err("未启动必须报错");
        assert!(error.contains("驱动未运行"), "{error}");
    }

    #[tokio::test]
    async fn start_without_spec_reports_a_clear_error() {
        let host = DriverHost::new();
        let error = host.start(None).await.expect_err("未配置必须报错");
        assert!(error.contains("未检测到"), "{error}");
    }

    #[tokio::test]
    async fn estop_is_idempotent_without_a_process() {
        let host = DriverHost::new();
        assert!(!host.estop().await, "没有进程时急停返回 false");
        let error = host
            .call_tool("click", json!({}))
            .await
            .expect_err("急停后不得再调用");
        assert!(error.contains("急停"), "{error}");
    }

    #[tokio::test]
    async fn status_reports_the_configured_command_without_starting_it() {
        let host = DriverHost::new();
        let status = host.status(Some(&spec())).await;
        assert!(status.configured);
        assert!(!status.running);
        assert_eq!(status.command.as_deref(), Some("cua-driver"));
    }
}
