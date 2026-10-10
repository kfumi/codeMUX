//! 电脑控制活动真值(工单 01)端到端契约:daemon 自己知道「这台机器正在被驱动」,
//! 并把这件事以 `computer-use-activity` 事件发到控制面 lane(没有会话归属的那条流)。
//!
//! 判据是「本回合试图驱动过桌面」,所以每条用例都先让 daemon 把回合标成在跑 ——
//! 生产路径上这一步由运行时事件驱动(`companion/events.rs`),测试里直接调。
//!
//! 与 tests/computer_use_approval.rs 同一套夹具写法(HTTP 手写 + 控制面 WS)。

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
    Fixture {
        _temp: temp,
        token,
        port,
        daemon,
    }
}

async fn stop(fixture: &Fixture) {
    stop_daemon_for_state(&fixture.daemon.companion)
        .await
        .expect("stop daemon");
}

async fn http_json(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let payload = body.to_string();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("Content-Type: application/json\r\n");
    request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(&payload);

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read response");
    let response = String::from_utf8_lossy(&buf).to_string();
    let status: u16 = response
        .strip_prefix("HTTP/1.1 ")
        .and_then(|rest| rest.get(..3))
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("无法解析状态行: {response}"));
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    let json_start = body.find('{').unwrap_or(body.len());
    let json = serde_json::from_str(&body[json_start..]).unwrap_or(serde_json::Value::Null);
    (status, json)
}

/// 连上控制面 WS(无 session_id):整机活动状态走这条流。
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

/// 带会话归属的一次桌面工具调用(生产路径:内置 MCP 一定带 session-id)。
async fn execute_desktop(
    port: u16,
    token: &str,
    session_id: &str,
    tool: &str,
) -> (u16, serde_json::Value) {
    http_json(
        port,
        "POST",
        "/api/computer-use/execute",
        Some(token),
        serde_json::json!({ "tool": tool, "sessionId": session_id, "params": {} }),
    )
    .await
}

/// 读下一条 `computer-use-activity` 帧的活动载荷(跳过 hello / 回合状态帧 / 其它 ui-event)。
async fn read_activity<S>(read: &mut S) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout(deadline, read.next())
            .await
            .expect("activity frame in time")
            .expect("stream open")
            .expect("message ok");
        let text = message.to_string();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if value["event"]["name"] == "computer-use-activity" {
                return value["event"]["payload"].clone();
            }
        }
    }
}

/// 无人值守(没有任何界面):回合里的桌面动作照样产生活动;界面后连上时先拿到快照。
#[tokio::test]
async fn an_unattended_turn_marks_activity_and_late_clients_get_the_snapshot() {
    const SESSION: &str = "session-unattended";
    let fixture = start_fixture().await;

    // daemon 这里只从运行时事件知道回合在跑,没有任何客户端参与。
    fixture.daemon.companion.mark_turn_active(SESSION);

    // 这次调用会失败(驱动没起来 / 开关没开)—— 正是要覆盖的形态:标记发生在闸门
    // 之前,「模型正在试图驱动桌面」本身就构成活动。
    let (status, body) =
        execute_desktop(fixture.port, &fixture.token, SESSION, "computer_click").await;
    assert_ne!(status, 200, "这条用例的场景里调用本来就跑不通: {body:?}");

    // 界面是后面才连上的:只靠「变化才发」会整段漏掉,所以连上先给一份快照。
    let mut ws = connect_control(fixture.port, &fixture.token).await;
    let payload = read_activity(&mut ws).await;
    assert_eq!(
        payload["active"], true,
        "无人值守的回合也产生活动: {payload:?}"
    );
    assert_eq!(payload["sessions"][0]["sessionId"], SESSION);

    stop(&fixture).await;
}

/// 活动帧跟着回合生命周期走,且**状态不变就不发**(每个桌面动作都标记,但不能每步刷一帧)。
#[tokio::test]
async fn activity_frames_follow_the_turn_and_do_not_repeat_on_every_step() {
    const SESSION: &str = "session-watched";
    let fixture = start_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;

    let idle = read_activity(&mut ws).await;
    assert_eq!(idle["active"], false, "刚连上时没有活动: {idle:?}");

    fixture.daemon.companion.mark_turn_active(SESSION);
    let _ = execute_desktop(fixture.port, &fixture.token, SESSION, "computer_click").await;
    let started = read_activity(&mut ws).await;
    assert_eq!(started["active"], true, "第一步桌面动作即活动: {started:?}");

    // 同回合的第二步:状态没变,控制面不该再收帧。
    let _ = execute_desktop(fixture.port, &fixture.token, SESSION, "computer_type").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), read_activity(&mut ws))
            .await
            .is_err(),
        "状态没变就不该再发活动帧"
    );

    // 回合结束(或用户打断):活动随之结束。
    fixture.daemon.companion.finish_turn(SESSION);
    let ended = read_activity(&mut ws).await;
    assert_eq!(ended["active"], false, "回合结束即解除活动: {ended:?}");

    stop(&fixture).await;
}
