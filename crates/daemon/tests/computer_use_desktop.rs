//! 桌面工具面(工单 13)端到端冒烟:真实 daemon + **真实驱动**,只读。
//!
//! 这里刻意只做只读动作(list_apps 与参数校验):测试不该动用户的鼠标键盘。
//! 输入动作的行为由 desktop.rs 的纯函数测试与 computer_use_approval.rs 的
//! 闸门契约覆盖。

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
