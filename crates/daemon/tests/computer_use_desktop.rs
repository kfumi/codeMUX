//! 桌面工具面的端到端用例:真实 daemon,驱动可以是**真驱动**或**假驱动**(stub)。
//!
//! 真驱动那几条刻意只做只读动作(list_apps 与参数校验):测试不该动用户的鼠标键盘,
//! 没装驱动的机器上它们会明确跳过。
//! 「翻译/裁决/闸门的顺序」「脱敏之后的整形」「写剪贴板失败就不粘贴」这类不变量由
//! 文件末尾的 stub 驱动契约测试覆盖 —— 那些用例在任何机器上都能跑,不跳过。

use std::time::Duration;

use codemux_lib::companion::{local_daemon_token, start_daemon_server, stop_daemon_for_state};
use codemux_lib::daemon::DaemonState;
use codemux_lib::paths::PathRoots;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

struct Fixture {
    _temp: tempfile::TempDir,
    token: String,
    port: u16,
    daemon: std::sync::Arc<DaemonState>,
}

async fn start_fixture() -> Fixture {
    let temp = tempfile::tempdir().expect("tempdir");
    let daemon = std::sync::Arc::new(
        DaemonState::assemble(
            PathRoots {
                app_data_dir: temp.path().to_path_buf(),
                resource_dir: None,
            },
            std::sync::Arc::new(codemux_lib::daemon::NullUiEventSink),
        )
        .expect("assemble"),
    );
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
    let port = probe.local_addr().expect("addr").port();
    drop(probe);
    start_daemon_server(daemon.clone(), port, false, "127.0.0.1".to_string())
        .await
        .expect("start daemon server");
    let token =
        local_daemon_token::ensure_local_daemon_token(temp.path(), true).expect("local token");
    daemon
        .companion
        .inner
        .approvals
        .set_timeout(Duration::from_millis(400));
    {
        let mut config = daemon.app.config.lock().unwrap();
        config.computer_use.enabled = true;
        config.computer_use.system_execution_enabled = true;
    }
    Fixture {
        _temp: temp,
        token,
        port,
        daemon,
    }
}

async fn stop(fixture: &Fixture) {
    let _ = stop_daemon_for_state(&fixture.daemon.companion).await;
}

async fn http_json(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let payload = body.to_string();
    let auth = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .and_then(|part| serde_json::from_str::<serde_json::Value>(part).ok())
        .unwrap_or(serde_json::Value::Null);
    (status, body)
}

async fn connect_control(
    port: u16,
    token: &str,
) -> impl futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin
{
    let url = format!("ws://127.0.0.1:{port}/api/ws?token={token}");
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect control ws");
    Box::pin(stream)
}

async fn read_event<S>(read: &mut S, expected: &str) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(10);
    loop {
        let message = tokio::time::timeout(deadline, read.next())
            .await
            .expect("event in time")
            .expect("stream open")
            .expect("message ok");
        let text = message.to_string();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if value["event"]["type"] == expected {
                return value;
            }
        }
    }
}

/// 参数写错的调用在启驱动之前就被拒(纯函数校验,不碰外部)。
#[tokio::test]
async fn malformed_desktop_calls_are_refused_before_any_driver_work() {
    let fixture = start_fixture().await;
    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/execute",
        Some(&fixture.token),
        serde_json::json!({
            "tool": "computer_click",
            "params": { "processId": 4, "windowId": 7, "elementIndex": 3, "x": 1.0, "y": 2.0 },
        }),
    )
    .await;
    assert_eq!(status, 403, "参数冲突应被拒: {body:?}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("只能给一个"),
        "文案要点明冲突: {body:?}"
    );
    stop(&fixture).await;
}

/// 未开启系统级执行时,任何桌面工具都被开关挡住(与壳侧桌面操作同一条门)。
#[tokio::test]
async fn the_system_execution_switch_gates_every_desktop_tool() {
    let fixture = start_fixture().await;
    fixture
        .daemon
        .app
        .config
        .lock()
        .unwrap()
        .computer_use
        .system_execution_enabled = false;
    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/execute",
        Some(&fixture.token),
        serde_json::json!({ "tool": "computer_apps", "params": {} }),
    )
    .await;
    assert_eq!(status, 403);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("系统级执行"),
        "文案要指向开关: {body:?}"
    );
    stop(&fixture).await;
}

/// 真驱动的只读往返:闸门放行 → 驱动执行 → 回包整形。
///
/// 机器上没装驱动时跳过(CI 里没有)—— 跳过是明确的,不是静默通过。
#[tokio::test]
async fn computer_apps_round_trips_through_the_gate_and_a_real_driver() {
    if codemux_lib::computer_use::probe::detect_default().is_none() {
        eprintln!("跳过:本机没有检测到电脑控制驱动");
        return;
    }
    let fixture = start_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;

    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move {
            http_json(
                port,
                "POST",
                "/api/computer-use/execute",
                Some(&token),
                serde_json::json!({ "tool": "computer_apps", "params": {} }),
            )
            .await
        }
    });
    // 只读也要人点一次(首次没有会话记忆)。
    let approval = read_event(&mut ws, "computer-use-approval-request").await;
    assert_eq!(approval["event"]["op"], "desktop-apps");
    assert_eq!(approval["event"]["risk"], "readOnly");
    let request_id = approval["event"]["requestId"].as_str().expect("requestId");
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "once" }),
    )
    .await;
    assert_eq!(status, 200);

    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 200, "只读应用清单应成功: {body:?}");
    let payload = &body["payload"];
    let text = payload["content"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["text"].as_str())
        .unwrap_or_default();
    assert!(text.contains("回执"), "要带回执: {text}");
    assert!(
        payload["content"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0)
            >= 2,
        "驱动的原文必须一起带走: {payload:?}"
    );

    stop(&fixture).await;
}

/// 启动应用没有目标窗口:name 必须走到「按应用名裁决」那一关,而不是被
/// 「缺少必填参数 processId」挡在门外。
///
/// 探针用内置拒绝范围里的应用名:裁决发生在驱动动作之前,所以这条用例不会真的
/// 启动任何东西;它盯的正是 execute/preflight 的顺序(回归点见 desktop.rs)。
#[tokio::test]
async fn launch_is_decided_by_app_name_not_by_a_missing_process_id() {
    if codemux_lib::computer_use::probe::detect_default().is_none() {
        eprintln!("跳过:本机没有检测到电脑控制驱动");
        return;
    }
    let fixture = start_fixture().await;
    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/execute",
        Some(&fixture.token),
        serde_json::json!({
            "tool": "computer_launch",
            "params": { "name": "powershell" },
        }),
    )
    .await;
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        !error.contains("processId"),
        "启动应用不该要求 processId:{body:?}"
    );
    assert!(
        error.contains("已拒绝启动"),
        "内置拒绝范围要按应用名拦下:{body:?}"
    );
    assert_eq!(status, 403, "拒绝走 403:{body:?}");
    stop(&fixture).await;
}

// ---------------------------------------------------------------------------
// 契约测试(假驱动):不需要真驱动、不需要桌面
// ---------------------------------------------------------------------------

/// 起一个装了假驱动的 daemon(真驱动不参与)。
async fn stub_fixture() -> (
    Fixture,
    std::sync::Arc<codemux_lib::computer_use::driver::DriverStub>,
) {
    let fixture = start_fixture().await;
    let stub = fixture.daemon.companion.inner.driver.install_stub();
    (fixture, stub)
}

/// 跑一次桌面工具并自动放行(桌面工具首次调用都要人点一次)。
async fn run_tool<S>(
    ws: &mut S,
    fixture: &Fixture,
    tool: &str,
    params: serde_json::Value,
) -> (u16, serde_json::Value)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        let tool = tool.to_string();
        async move {
            http_json(
                port,
                "POST",
                "/api/computer-use/execute",
                Some(&token),
                serde_json::json!({ "tool": tool, "params": params }),
            )
            .await
        }
    });
    let approval = read_event(ws, "computer-use-approval-request").await;
    let request_id = approval["event"]["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "once" }),
    )
    .await;
    assert_eq!(status, 200, "放行失败");
    pending.await.expect("execute 应结束")
}

/// 回归点(2026-10-10):目标窗口的解析跑在启动裁决之前,launch 分支成了死代码,
/// 模型拿到的是「缺少必填参数 processId」。这里盯的是「驱动实际收到了什么」。
#[tokio::test]
async fn a_launch_reaches_the_driver_by_app_name_without_a_process_id() {
    let (fixture, stub) = stub_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;
    stub.respond(
        "launch_app",
        serde_json::json!({ "content": [{ "type": "text", "text": "✅ Launched" }] }),
    );
    let (status, body) = run_tool(
        &mut ws,
        &fixture,
        "computer_launch",
        serde_json::json!({ "name": "notepad" }),
    )
    .await;
    assert_eq!(status, 200, "启动应用不该被 processId 挡在门外: {body:?}");
    let calls = stub.calls();
    assert_eq!(calls.len(), 1, "只该有一次驱动调用: {calls:?}");
    assert_eq!(calls[0].0, "launch_app");
    assert_eq!(calls[0].1, serde_json::json!({ "name": "notepad" }));
    stop(&fixture).await;
}

/// 脱敏之后才整形:驱动文本里的原始值一个字节都不能进回包。
#[tokio::test]
async fn a_sensitive_value_never_survives_the_shaping() {
    let (fixture, stub) = stub_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;
    stub.respond(
        "get_window_state",
        serde_json::json!({
            // 形状照抄驱动:content 是它渲染的文本(带原始值),structuredContent 才能脱敏。
            "content": [{ "type": "text", "text": "- [2] Edit \"验证码\" [value=\"123456\"]\n" }],
            "structuredContent": {
                "pid": 4,
                "window_id": 7,
                "window_title": "登录",
                "snapshot_id": "s00000001",
                "elements_complete": true,
                "returned_element_count": 2,
                "total_element_count": 2,
                "nodes_visited": 5,
                "tree_markdown": "- [2] Edit \"验证码\" [value=\"123456\"]\n",
                "elements": [
                    { "element_index": 1, "depth": 1, "role": "Edit", "label": "用户名", "value": "alice" },
                    { "element_index": 2, "depth": 1, "role": "Edit", "label": "验证码", "value": "123456" }
                ]
            }
        }),
    );
    let (status, body) = run_tool(
        &mut ws,
        &fixture,
        "computer_elements",
        serde_json::json!({ "processId": 4, "windowId": 7 }),
    )
    .await;
    assert_eq!(status, 200, "{body:?}");
    let whole = serde_json::to_string(&body).unwrap_or_default();
    assert!(!whole.contains("123456"), "敏感值不该出现在回包里: {whole}");
    assert!(
        !whole.contains("tree_markdown"),
        "驱动那份带原始值的树文本要清掉: {whole}"
    );
    assert!(whole.contains("已脱敏"), "要显示为已脱敏: {whole}");
    assert!(
        whole.contains("snapshot=s00000001"),
        "回执要带 snapshotId: {whole}"
    );
    stop(&fixture).await;
}

/// 跨步契约:写剪贴板失败就不投 Ctrl+V(半途而废比不做更糟)。
#[tokio::test]
async fn a_failed_clipboard_write_never_reaches_ctrl_v() {
    let (fixture, stub) = stub_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;
    stub.respond(
        "list_windows",
        serde_json::json!({
            "structuredContent": {
                "windows": [{ "pid": 4, "window_id": 7, "title": "记事本", "app_name": "notepad.exe" }]
            }
        }),
    );
    stub.fail(
        "clipboard_write",
        "Clipboard write is unavailable: OSError(5)",
    );
    let (status, body) = run_tool(
        &mut ws,
        &fixture,
        "computer_paste",
        serde_json::json!({ "processId": 4, "windowId": 7, "text": "测试123" }),
    )
    .await;
    assert_eq!(status, 403, "写剪贴板失败要拒绝这次粘贴: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(error.contains("没有粘贴"), "{error}");
    assert!(error.contains("剪贴板没有被改动"), "{error}");
    assert!(
        !stub.called("hotkey"),
        "写剪贴板失败就不该投 Ctrl+V: {:?}",
        stub.calls()
    );
    stop(&fixture).await;
}

/// 参数成对纪律:elementIndex 缺 snapshotId 时本地就拒,驱动不该被打扰。
#[tokio::test]
async fn a_malformed_action_never_reaches_the_driver() {
    let (fixture, stub) = stub_fixture().await;
    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/execute",
        Some(&fixture.token),
        serde_json::json!({
            "tool": "computer_type",
            "params": { "processId": 4, "windowId": 7, "elementIndex": 3, "text": "x" },
        }),
    )
    .await;
    assert_eq!(status, 403, "{body:?}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("snapshotId"),
        "{body:?}"
    );
    assert!(
        stub.calls().is_empty(),
        "本地拒绝就不该碰驱动: {:?}",
        stub.calls()
    );
    stop(&fixture).await;
}
