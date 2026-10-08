//! 浏览器自动化接缝(工单 08)契约测试:真实 daemon 服务(无窗口组装)上的
//! 请求-响应与鉴权矩阵。
//!
//! - HTTP:原始 TCP 手写请求(仓库无 reqwest 测试基建,与 tests/daemon_binary.rs
//!   的探活写法一致);
//! - WS:tokio-tungstenite 客户端持 Local Daemon Token 连 `/ws`(无 session_id =
//!   控制面),接收 `browser-automation-request` 后经 HTTP POST result 回填。

use std::time::Duration;

use codemux_lib::companion::{local_daemon_token, start_daemon_server, stop_daemon_for_state};
use codemux_lib::daemon::DaemonState;
use codemux_lib::paths::PathRoots;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

struct DaemonFixture {
    _temp: tempfile::TempDir,
    token: String,
    port: u16,
    daemon: std::sync::Arc<DaemonState>,
}

async fn start_daemon_fixture() -> DaemonFixture {
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

    let token = local_daemon_token::ensure_local_daemon_token(temp.path(), true)
        .expect("local daemon token");
    DaemonFixture {
        _temp: temp,
        token,
        port,
        daemon,
    }
}

async fn stop_daemon(fixture: &DaemonFixture) {
    stop_daemon_for_state(&fixture.daemon.companion)
        .await
        .expect("stop daemon");
}

/// 打开「设置 → 浏览器控制」开关(内存配置;既有用例默认走开启态)。
fn enable_browser_control(fixture: &DaemonFixture) {
    fixture.daemon.app.config.lock().unwrap().browser.enabled = true;
}

/// 原始 TCP HTTP/1.1 请求:返回 (状态码, JSON body)。
async fn http_json(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let payload = body.unwrap_or(serde_json::Value::Null).to_string();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if !payload.is_empty() && payload != "null" {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
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

async fn execute_automation(
    port: u16,
    token: Option<&str>,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    http_json(
        port,
        "POST",
        "/api/browser-automation/execute",
        token,
        Some(body),
    )
    .await
}

/// 从控制面 WS 上取下一帧事件(5s 兜底)。
async fn read_control_event<S>(read: &mut S) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout(deadline, read.next())
            .await
            .expect("control event in time")
            .expect("stream open")
            .expect("message ok");
        let text = message.to_string();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if value["event"]["type"].is_string() {
                return value;
            }
        }
    }
}

/// 收 automation 请求事件;途中的电脑控制审批请求(工单 03 闸门)一律按
/// 「单步放行」应答 —— 这条测试关心的是审批之后的执行链路,审批本身由
/// `computer_use_approval` 系列用例覆盖。
async fn read_automation_request<S>(read: &mut S, port: u16, token: &str) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let value = read_control_event(read).await;
        match value["event"]["type"].as_str() {
            Some("browser-automation-request") => return value,
            Some("computer-use-approval-request") => {
                let request_id = value["event"]["requestId"]
                    .as_str()
                    .expect("审批请求带 requestId");
                let (status, body) = http_json(
                    port,
                    "POST",
                    "/api/computer-use/approval",
                    Some(token),
                    Some(serde_json::json!({ "requestId": request_id, "choice": "once" })),
                )
                .await;
                assert_eq!(status, 200, "单步放行应被闸门接受: {body:?}");
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 鉴权矩阵
// ---------------------------------------------------------------------------

#[tokio::test]
async fn execute_rejects_missing_wrong_and_pairing_tokens() {
    let fixture = start_daemon_fixture().await;

    // 缺 token → 401。
    let (status, _) = execute_automation(
        fixture.port,
        None,
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(status, 401, "缺 token 必须 401");

    // 错 token → 401。
    let (status, _) = execute_automation(
        fixture.port,
        Some("not-the-local-token"),
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(status, 401, "错 token 必须 401");

    // 真实 Pairing Token(已入库)在回环上仍必须 401:自动化面只认 Local Daemon Token。
    let pairing = codemux_lib::companion::pairing::complete_pairing(
        &fixture.daemon.app,
        Some("contract-test-device"),
    )
    .expect("complete pairing");
    let (status, body) = execute_automation(
        fixture.port,
        Some(&pairing.token),
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(status, 401, "Pairing Token 必须 401,got {body:?}");

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn execute_blocked_with_403_when_browser_control_disabled() {
    let fixture = start_daemon_fixture().await;
    // 默认配置 browser.enabled=false:鉴权放行后必须被设置闸门 401→403 拦下,
    // 且不落挂起表(文案面向用户,工具层会原样转述进对话)。
    let (status, body) = execute_automation(
        fixture.port,
        Some(&fixture.token),
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(status, 403, "关闭内置浏览器控制必须 403,got {body:?}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("浏览器控制未开启"),
        "403 文案应引导用户开开关,got {body:?}"
    );

    // 开启后不再被开关拦下:请求走到审批闸门(工单 03)。此处没有界面订阅,
    // 闸门按 fail closed 收口 —— 错误文案不再是「未开启」,而是「没人应答」。
    enable_browser_control(&fixture);
    let (status, body) = execute_automation(
        fixture.port,
        Some(&fixture.token),
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(status, 403, "过闸门后由审批裁决,got {body:?}");
    assert!(
        !body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("浏览器控制未开启"),
        "开关已开,不应再报未开启: {body:?}"
    );

    // 无人应答的放行请求一律拒绝(超时/无界面都算拒绝,不给「静默放行」留缝)。
    let (status, body) = execute_automation(
        fixture.port,
        Some(&fixture.token),
        serde_json::json!({"browserId": "b1", "op": "list", "params": {}}),
    )
    .await;
    assert_eq!(status, 403, "只读操作同样要人放行,got {body:?}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("没有订阅该会话的界面"),
        "拒绝文案要说明为什么没人应答: {body:?}"
    );

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn execute_with_local_token_passes_auth_then_fails_fast_without_client() {
    let fixture = start_daemon_fixture().await;
    enable_browser_control(&fixture);

    // 回环 + Local Daemon Token:鉴权放行、op 校验放行,随后由审批闸门收口
    // (无界面订阅 → fail closed)。这里断言的是「不是 401、也不是 op 400」。
    let (status, body) = execute_automation(
        fixture.port,
        Some(&fixture.token),
        serde_json::json!({"browserId": "b1", "op": "eval", "params": {"code": "1"}}),
    )
    .await;
    assert_eq!(
        status, 403,
        "有 token 回环应过鉴权(403=审批无人应答),got {body:?}"
    );
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("没有订阅该会话的界面"),
        "got {body:?}"
    );

    // list 操作同样在合法 op 集合内(不需要目标页),同样走到审批闸门。
    let (status, body) = execute_automation(
        fixture.port,
        Some(&fixture.token),
        serde_json::json!({"op": "list", "params": {}}),
    )
    .await;
    assert_eq!(status, 403, "list 应被 op 校验接受,停在审批,got {body:?}");
    assert!(
        !body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Unknown browser automation op"),
        "list 是合法 op: {body:?}"
    );

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn execute_rejects_unknown_op_with_400() {
    let fixture = start_daemon_fixture().await;
    enable_browser_control(&fixture);

    for op in ["aria-snapshot", "EVAL", "eval "] {
        let (status, body) = execute_automation(
            fixture.port,
            Some(&fixture.token),
            serde_json::json!({"browserId": "b1", "op": op, "params": {}}),
        )
        .await;
        assert_eq!(status, 400, "未知 op {op:?} 必须 400,got {body:?}");
    }

    stop_daemon(&fixture).await;
}

// ---------------------------------------------------------------------------
// 请求-响应回路
// ---------------------------------------------------------------------------

#[tokio::test]
async fn execute_roundtrip_via_ws_client_result() {
    let fixture = start_daemon_fixture().await;
    enable_browser_control(&fixture);

    let stream = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/api/ws?token={}",
        fixture.port, fixture.token
    ))
    .await
    .expect("connect ws")
    .0;
    let (_write, mut read) = stream.split();
    let hello = tokio::time::timeout(Duration::from_secs(5), read.next())
        .await
        .expect("hello in time")
        .expect("hello message")
        .expect("hello ok");
    assert!(
        hello.to_string().contains("\"hello\""),
        "先收 hello: {hello}"
    );

    // 发起 execute(挂起等待),再从 WS 收请求。
    let port = fixture.port;
    let token = fixture.token.clone();
    let execute_task = tokio::spawn(async move {
        execute_automation(
            port,
            Some(&token),
            serde_json::json!({
                "browserId": "browser-1",
                "op": "eval",
                "params": {"code": "1+1"}
            }),
        )
        .await
    });

    let event = read_automation_request(&mut read, fixture.port, &fixture.token).await;
    assert_eq!(event["event"]["browserId"], "browser-1");
    assert_eq!(event["event"]["op"], "eval");
    assert_eq!(event["event"]["params"]["code"], "1+1");
    let request_id = event["event"]["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();

    // 回填 result(execute HTTP 挂起中)。
    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        Some(serde_json::json!({
            "requestId": request_id,
            "ok": true,
            "payload": {"value": "42"}
        })),
    )
    .await;
    assert_eq!(status, 200, "result 受理应 200,got {body:?}");

    let (execute_status, execute_body) = execute_task.await.expect("execute task");
    assert_eq!(
        execute_status, 200,
        "execute 应返回结果,got {execute_body:?}"
    );
    assert_eq!(execute_body["ok"], true);
    assert_eq!(execute_body["payload"]["value"], "42");
    assert_eq!(execute_body["requestId"], request_id);

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn shell_error_result_is_forwarded_as_ok_false() {
    let fixture = start_daemon_fixture().await;
    enable_browser_control(&fixture);

    let stream = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/api/ws?token={}",
        fixture.port, fixture.token
    ))
    .await
    .expect("connect ws")
    .0;
    let (_write, mut read) = stream.split();
    let hello = tokio::time::timeout(Duration::from_secs(5), read.next())
        .await
        .expect("hello in time")
        .expect("hello message")
        .expect("hello ok");
    assert!(hello.to_string().contains("\"hello\""));

    let port = fixture.port;
    let token = fixture.token.clone();
    let execute_task = tokio::spawn(async move {
        execute_automation(
            port,
            Some(&token),
            serde_json::json!({"browserId": "ghost", "op": "cdp", "params": {"method": "Page.navigate"}}),
        )
        .await
    });

    let event = read_automation_request(&mut read, fixture.port, &fixture.token).await;
    let request_id = event["event"]["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();

    // 壳侧报错(browserId 找不到):ok=false + error。
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        Some(serde_json::json!({
            "requestId": request_id,
            "ok": false,
            "error": "browser not found: ghost"
        })),
    )
    .await;
    assert_eq!(status, 200);

    let (execute_status, execute_body) = execute_task.await.expect("execute task");
    assert_eq!(execute_status, 200);
    assert_eq!(execute_body["ok"], false);
    assert_eq!(execute_body["error"], "browser not found: ghost");

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn result_with_unknown_request_id_is_400() {
    let fixture = start_daemon_fixture().await;

    let (status, body) = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        Some(serde_json::json!({"requestId": "nope", "ok": true, "payload": 1})),
    )
    .await;
    assert_eq!(status, 400, "未知 requestId 必须 400,got {body:?}");

    stop_daemon(&fixture).await;
}

#[tokio::test]
async fn execute_times_out_with_injected_short_timeout() {
    let fixture = start_daemon_fixture().await;
    enable_browser_control(&fixture);

    // 测试注入:等待超时 300ms(生产固定 15s)。
    fixture
        .daemon
        .companion
        .inner
        .browser_automation
        .set_timeout(Duration::from_millis(300));

    let stream = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/api/ws?token={}",
        fixture.port, fixture.token
    ))
    .await
    .expect("connect ws")
    .0;
    let (_write, mut read) = stream.split();
    let hello = tokio::time::timeout(Duration::from_secs(5), read.next())
        .await
        .expect("hello in time")
        .expect("hello message")
        .expect("hello ok");
    assert!(hello.to_string().contains("\"hello\""));

    let port = fixture.port;
    let token = fixture.token.clone();
    let execute_task = tokio::spawn(async move {
        execute_automation(
            port,
            Some(&token),
            serde_json::json!({"browserId": "b1", "op": "screenshot", "params": {}}),
        )
        .await
    });

    // 收到请求但不回 result → execute 必须按注入的超时(300ms)返回 504。
    let event = read_automation_request(&mut read, fixture.port, &fixture.token).await;
    let request_id = event["event"]["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();

    let started = std::time::Instant::now();
    let (status, body) = execute_task.await.expect("execute task");
    let elapsed = started.elapsed();
    assert_eq!(status, 504, "不回结果必须 504 超时,got {body:?}");
    assert!(
        elapsed < Duration::from_secs(5),
        "超时应按注入值快速返回,实际 {elapsed:?}"
    );

    // 超时后挂起项被移除:迟到的 result 按 400 拒绝。
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        Some(serde_json::json!({"requestId": request_id, "ok": true, "payload": "late"})),
    )
    .await;
    assert_eq!(status, 400, "超时后的迟到 result 必须 400");

    stop_daemon(&fixture).await;
}
