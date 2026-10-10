//! 电脑控制审批闸门(工单 03)端到端契约:真实 daemon 上的「放行 → 执行」
//! 「拦截 → 拒绝」「单步放行不被记住」「只读可本会话记住」四条路径。
//!
//! 工单 19 起还覆盖**受众**这一维:一条放行请求有没有界面能应答
//! (`has_approval_audience`),决定它「立刻按没界面收口」还是「等满等待窗口」。
//!
//! 与 tests/browser_automation.rs 同一套夹具写法(HTTP 手写 + 控制面 WS),
//! 但关注点在闸门本身而不是执行链路。

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
    // 审批等待在测试里收敛到毫秒级:闸门的超时路径不该让测试挂两分钟。
    daemon
        .companion
        .inner
        .approvals
        .set_timeout(Duration::from_millis(300));
    daemon.app.config.lock().unwrap().browser.enabled = true;
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

/// 连上控制面 WS(无 session_id):无会话归属的审批与自动化请求在这条流上。
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

/// 连上某个会话的 WS:带会话归属的审批与自动化请求走这条流(会话隔离)。
async fn connect_session(
    port: u16,
    token: &str,
    session_id: &str,
) -> impl futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin
{
    let url = format!("ws://127.0.0.1:{port}/api/ws?token={token}&sessionId={session_id}");
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect session ws");
    Box::pin(stream)
}

/// 等 daemon 侧真的把这条流记成「有界面在看」。连接建立与订阅记账是异步的,不等的话
/// 断言会跟启动赛跑(先发请求,订阅才记上)。
async fn wait_until_watched(daemon: &std::sync::Arc<DaemonState>, session_id: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if daemon.companion.inner.has_ui_subscriber(session_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daemon 一直没把 {session_id} 记成被界面订阅");
}

/// 带会话归属的一次 execute(生产路径:MCP server 一定带 --session-id)。
async fn execute_in_session(
    port: u16,
    token: &str,
    session_id: &str,
    op: &str,
    tool: &str,
) -> (u16, serde_json::Value) {
    http_json(
        port,
        "POST",
        "/api/browser-automation/execute",
        Some(token),
        serde_json::json!({ "op": op, "tool": tool, "sessionId": session_id, "params": {} }),
    )
    .await
}

async fn read_event<S>(read: &mut S, expected: &str) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(5);
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

/// 读下一条带事件体的帧(用于断言「某类事件没有出现」)。
async fn read_next_event<S>(read: &mut S) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout(deadline, read.next())
            .await
            .expect("event in time")
            .expect("stream open")
            .expect("message ok");
        let text = message.to_string();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if value.get("event").is_some() {
                return value;
            }
        }
    }
}

async fn execute(port: u16, token: &str, op: &str, tool: &str) -> (u16, serde_json::Value) {
    http_json(
        port,
        "POST",
        "/api/browser-automation/execute",
        Some(token),
        serde_json::json!({ "op": op, "tool": tool, "params": {} }),
    )
    .await
}

/// 在后台发起一次 execute(它会挂起等放行),返回 JoinHandle。
fn spawn_execute(
    port: u16,
    token: String,
    op: &'static str,
    tool: &'static str,
) -> tokio::task::JoinHandle<(u16, serde_json::Value)> {
    tokio::spawn(async move { execute(port, &token, op, tool).await })
}

#[tokio::test]
async fn rejecting_an_approval_blocks_the_step_with_a_model_facing_message() {
    let fixture = start_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;

    let pending = spawn_execute(
        fixture.port,
        fixture.token.clone(),
        "click",
        "browser_click",
    );
    let approval = read_event(&mut ws, "computer-use-approval-request").await;
    assert_eq!(approval["event"]["risk"], "input");
    // 输入动作不给「本会话记住」,给的是**限时授权**(工单 13):界面据此渲染
    // 「允许 N 分钟」,而那个授权按 (会话, 回合) 记账、到期与 Esc 都会收回。
    assert_eq!(
        approval["event"]["grant"]["ttlSeconds"], 180,
        "输入动作应带限时授权时长: {approval:?}"
    );
    assert_eq!(approval["event"]["grant"]["scope"], "本回合的输入动作");

    let request_id = approval["event"]["requestId"].as_str().expect("requestId");
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "reject" }),
    )
    .await;
    assert_eq!(status, 200);

    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 403, "拦截后必须是 403: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(error.contains("用户拦截"), "文案要说明被拦了: {error}");
    assert!(
        error.contains("不要重试"),
        "文案要阻止模型换写法重试: {error}"
    );

    stop(&fixture).await;
}

#[tokio::test]
async fn allow_once_lets_the_step_proceed_and_is_not_remembered() {
    let fixture = start_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;

    let pending = spawn_execute(
        fixture.port,
        fixture.token.clone(),
        "click",
        "browser_click",
    );
    let approval = read_event(&mut ws, "computer-use-approval-request").await;
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

    // 放行后请求真的下到壳侧:自动化请求出现在控制面 WS 上。
    let automation = read_event(&mut ws, "browser-automation-request").await;
    assert_eq!(automation["event"]["op"], "click");
    let automation_id = automation["event"]["requestId"]
        .as_str()
        .expect("automation requestId");
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        serde_json::json!({ "requestId": automation_id, "ok": true, "payload": null }),
    )
    .await;
    assert_eq!(status, 200, "回包应被接受");

    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 200, "放行 + 执行成功应 200: {body:?}");
    assert_eq!(body["ok"], true);

    // 第二次同类操作必须重新问人:输入动作的「单步放行」不留记忆。
    let pending = spawn_execute(
        fixture.port,
        fixture.token.clone(),
        "click",
        "browser_click",
    );
    let second = read_event(&mut ws, "computer-use-approval-request").await;
    assert_eq!(second["event"]["op"], "click");
    let request_id = second["event"]["requestId"].as_str().expect("requestId");
    let _ = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "reject" }),
    )
    .await;
    let _ = pending.await;

    stop(&fixture).await;
}

#[tokio::test]
async fn session_scoped_approvals_stay_on_the_session_stream_and_fail_closed() {
    let fixture = start_fixture().await;
    let mut ws = connect_control(fixture.port, &fixture.token).await;

    // 带会话归属的审批走会话流:控制面订阅者收不到(会话隔离)。
    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move {
            http_json(
                port,
                "POST",
                "/api/browser-automation/execute",
                Some(&token),
                serde_json::json!({
                    "op": "snapshot",
                    "tool": "browser_snapshot",
                    "sessionId": "session-approval",
                    "params": {},
                }),
            )
            .await
        }
    });

    assert!(
        tokio::time::timeout(
            Duration::from_millis(200),
            read_event(&mut ws, "computer-use-approval-request"),
        )
        .await
        .is_err(),
        "带会话的审批不该出现在控制面(会话隔离)"
    );

    // 没人放行 → 超时按拒绝收口(fail closed):电脑控制没有「无人值守自动放行」。
    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 403, "无人放行必须拒绝: {body:?}");
    assert!(
        body["error"].as_str().unwrap_or_default().contains("超时"),
        "超时文案: {body:?}"
    );

    stop(&fixture).await;
}

/// 步数上限(需求 22):到顶就停,不再打扰用户点放行。
///
/// 这条护栏以前只存在于设置页文案里(评审发现),现在是真会拒绝。
/// 步数按会话计数,所以这条用例走带 `--session-id` 的生产路径。
#[tokio::test]
async fn step_budget_stops_the_loop_at_the_configured_limit() {
    const SESSION: &str = "session-steps";
    let fixture = start_fixture().await;
    fixture
        .daemon
        .app
        .config
        .lock()
        .unwrap()
        .computer_use
        .max_steps = 2;
    // 两条流各司其职:审批请求走会话流(界面在看),自动化请求走控制面(壳在听)。
    let mut session_ws = connect_session(fixture.port, &fixture.token, SESSION).await;
    let mut control_ws = connect_control(fixture.port, &fixture.token).await;

    for expected_step in 1..=2 {
        let pending = tokio::spawn({
            let token = fixture.token.clone();
            let port = fixture.port;
            async move { execute_in_session(port, &token, SESSION, "click", "browser_click").await }
        });
        let approval = read_event(&mut session_ws, "computer-use-approval-request").await;
        assert_eq!(
            approval["event"]["risk"], "input",
            "第 {expected_step} 步应等到审批"
        );
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

        let automation = read_event(&mut control_ws, "browser-automation-request").await;
        let automation_id = automation["event"]["requestId"].as_str().expect("id");
        let (status, _) = http_json(
            fixture.port,
            "POST",
            "/api/browser-automation/result",
            Some(&fixture.token),
            serde_json::json!({ "requestId": automation_id, "ok": true, "payload": null }),
        )
        .await;
        assert_eq!(status, 200);
        let (status, body) = pending.await.expect("execute 应结束");
        assert_eq!(status, 200, "第 {expected_step} 步应成功: {body:?}");
    }

    // 第三步:额度用尽 —— 连审批都不问,直接停。
    let (status, body) = execute_in_session(
        fixture.port,
        &fixture.token,
        SESSION,
        "click",
        "browser_click",
    )
    .await;
    assert_eq!(status, 403, "到顶必须拒绝: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(error.contains("步数已到上限"), "文案要说明到顶: {error}");
    assert!(error.contains("2 步"), "文案要带上限值: {error}");
    assert!(
        tokio::time::timeout(
            Duration::from_millis(150),
            read_event(&mut session_ws, "computer-use-approval-request"),
        )
        .await
        .is_err(),
        "额度用尽后不该再弹放行请求"
    );

    stop(&fixture).await;
}

/// 工单 13:输入动作上的「允许 N 分钟」是**限时授权**,不是「记住」——
/// 授权内同一会话同一回合的后续输入不再弹卡;新回合不继承,到期与 Esc 收回。
#[tokio::test]
async fn a_time_boxed_grant_covers_later_input_actions_in_the_same_turn() {
    const SESSION: &str = "session-control-grant";
    let fixture = start_fixture().await;
    // 两条流各司其职:审批请求走会话流(界面在看),自动化请求走控制面(壳在听)。
    let mut session_ws = connect_session(fixture.port, &fixture.token, SESSION).await;
    let mut control_ws = connect_control(fixture.port, &fixture.token).await;

    // 第一步:审批卡选「允许 N 分钟」(always)。
    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move { execute_in_session(port, &token, SESSION, "click", "browser_click").await }
    });
    let approval = read_event(&mut session_ws, "computer-use-approval-request").await;
    assert_eq!(approval["event"]["grant"]["ttlSeconds"], 180);
    let request_id = approval["event"]["requestId"].as_str().expect("requestId");
    let (status, _) = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "always" }),
    )
    .await;
    assert_eq!(status, 200);
    let automation = read_event(&mut control_ws, "browser-automation-request").await;
    let automation_id = automation["event"]["requestId"]
        .as_str()
        .expect("automation requestId");
    let _ = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        serde_json::json!({ "requestId": automation_id, "ok": true, "payload": null }),
    )
    .await;
    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 200, "授权后第一步应成功: {body:?}");

    // 第二步:同一会话同一回合,授权内直接下到执行侧 —— 中间不该再出现审批卡。
    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move { execute_in_session(port, &token, SESSION, "click", "browser_click").await }
    });
    let mut saw_approval = false;
    let automation = loop {
        let event = read_next_event(&mut control_ws).await;
        match event["event"]["type"].as_str() {
            Some("computer-use-approval-request") => saw_approval = true,
            Some("browser-automation-request") => break event,
            _ => {}
        }
    };
    assert!(!saw_approval, "限时授权内不应再次弹审批卡");
    let automation_id = automation["event"]["requestId"]
        .as_str()
        .expect("automation requestId");
    let _ = http_json(
        fixture.port,
        "POST",
        "/api/browser-automation/result",
        Some(&fixture.token),
        serde_json::json!({ "requestId": automation_id, "ok": true, "payload": null }),
    )
    .await;
    let (status, body) = pending.await.expect("execute 应结束");
    assert_eq!(status, 200, "授权内第二步应放行: {body:?}");

    // 新回合(回合代次自增)不继承授权:又要问人。
    let _epoch = fixture.daemon.companion.mark_turn_active(SESSION);
    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move { execute_in_session(port, &token, SESSION, "click", "browser_click").await }
    });
    let approval = read_event(&mut session_ws, "computer-use-approval-request").await;
    assert_eq!(approval["event"]["op"], "click", "新回合必须重新问人");
    let request_id = approval["event"]["requestId"].as_str().expect("requestId");
    let _ = http_json(
        fixture.port,
        "POST",
        "/api/computer-use/approval",
        Some(&fixture.token),
        serde_json::json!({ "requestId": request_id, "choice": "reject" }),
    )
    .await;
    let _ = pending.await;

    stop(&fixture).await;
}

/// 工单 19:界面上只有**别的**会话时,这张审批卡谁也看不到 —— 广播有接收者(所以旧的
/// 「广播失败就拒绝」兜底不会触发),但这个会话没有界面能应答,仍不该让模型白等满等待
/// 窗口。这正是受众检查相对那个兜底多出来的那一格。
#[tokio::test]
async fn a_gate_with_no_ui_for_this_session_denies_immediately() {
    let fixture = start_fixture().await;
    // 把等待窗口拉长:这条用例要证明的是「根本没等」,不是「等到了超时」。
    fixture
        .daemon
        .companion
        .inner
        .approvals
        .set_timeout(Duration::from_secs(5));
    let _other = connect_session(fixture.port, &fixture.token, "session-other").await;
    wait_until_watched(&fixture.daemon, "session-other").await;

    let started = std::time::Instant::now();
    let (status, body) = execute_in_session(
        fixture.port,
        &fixture.token,
        "session-headless",
        "click",
        "browser_click",
    )
    .await;
    let elapsed = started.elapsed();

    assert_eq!(status, 403, "没有界面能放行时必须拒绝: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("没有订阅该会话的界面"),
        "文案要说明是没界面应答: {error}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "没人能看到这条放行请求时不该等满等待窗口,实际等了 {elapsed:?}"
    );

    stop(&fixture).await;
}

/// 工单 19:壳在跑(控制面订阅着)时**保留整段等待窗口** —— 会话当前没人看,但用户还能
/// 在窗口期内打开这条会话看到卡片放行,这是既有能力,不能被受众检查砍掉。
#[tokio::test]
async fn a_running_shell_keeps_the_full_approval_window_open() {
    let fixture = start_fixture().await;
    let _control = connect_control(fixture.port, &fixture.token).await;
    let started = std::time::Instant::now();
    let (status, body) = execute_in_session(
        fixture.port,
        &fixture.token,
        "session-unwatched",
        "click",
        "browser_click",
    )
    .await;
    let elapsed = started.elapsed();

    assert_eq!(status, 403, "无人放行必须拒绝: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("超时"),
        "有壳在跑时应走完整等待窗口再超时: {error}"
    );
    assert!(
        !error.contains("没有订阅该会话的界面"),
        "壳在跑时不能说「没有界面能应答」: {error}"
    );
    assert!(
        elapsed >= Duration::from_millis(300),
        "应等满(测试里收敛过的)等待窗口,实际 {elapsed:?}"
    );

    stop(&fixture).await;
}

/// 工单 19:唯一能展示审批卡的界面断开(用户关掉会话/退出应用)时,挂起的放行立刻按
/// 「放行界面已断开」收口,而不是让模型干等满等待窗口。
#[tokio::test]
async fn losing_the_last_ui_abandons_pending_approvals() {
    const SESSION: &str = "session-orphan";
    let fixture = start_fixture().await;
    fixture
        .daemon
        .companion
        .inner
        .approvals
        .set_timeout(Duration::from_secs(5));
    let mut session_ws = connect_session(fixture.port, &fixture.token, SESSION).await;

    let pending = tokio::spawn({
        let token = fixture.token.clone();
        let port = fixture.port;
        async move { execute_in_session(port, &token, SESSION, "click", "browser_click").await }
    });
    let approval = read_event(&mut session_ws, "computer-use-approval-request").await;
    assert_eq!(approval["event"]["op"], "click");

    // 界面断开:这时系统里已经没有任何地方能展示这张审批卡了。
    drop(session_ws);
    let started = std::time::Instant::now();
    let (status, body) = pending.await.expect("execute 应结束");
    let elapsed = started.elapsed();
    assert_eq!(status, 403, "界面没了必须拒绝: {body:?}");
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("放行界面已断开"),
        "文案要说明是放行界面断开了: {error}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "界面断开后不该再等满等待窗口,实际等了 {elapsed:?}"
    );

    stop(&fixture).await;
}
