//! 浏览器自动化接缝(工单 08):daemon → 壳内页面的受控自动化方法面。
//!
//! 链路:HTTP `POST /api/browser-automation/execute`(仅回环 + Local Daemon Token)
//! → 「开启内置浏览器控制」闸门(browser.enabled,关闭即 403)→ 生成 requestId
//! → 经既有 WS 广播机制(`CompanionBroadcastEvent`,session_id 为空
//! 表示控制面事件)广播 `browser-automation-request` → 壳(Electron main 进程的
//! 自动化客户端)经 FIFO 队列串行执行 → `POST /api/browser-automation/result`
//! 回填结果 → oneshot 唤醒挂起的 execute,HTTP 响应返回结果 payload。
//!
//! 挂起表并发安全(`Mutex<HashMap<requestId, oneshot::Sender>>`);等待超时默认
//! 15s(测试可经 `AutomationRegistry::set_timeout` 注入更短超时);超时后挂起项
//! 被移除,迟到 result 报 400(未知 requestId)。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::RwLock;
use std::time::Duration;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::companion::local_daemon_token;
use crate::companion::server::{is_loopback_peer, ApiError, ServerContext};
use crate::companion::state::CompanionBroadcastEvent;

/// 自动化请求的默认等待超时;测试经 [`AutomationRegistry::set_timeout`] 注入更短值。
pub const AUTOMATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 合法自动化操作集合(壳侧按 op 分发执行)。
///
/// 前十个是浏览器级(01 票);`desktop-*` 三个是桌面只读观测(04 票),
/// 由 `computer_use.enabled` 单独闸门 —— 开浏览器控制不等于允许看桌面。
pub const AUTOMATION_OPS: [&str; 13] = [
    "eval",
    "screenshot",
    "input",
    "cdp",
    "list",
    "snapshot",
    "click",
    "type",
    "scroll",
    "select",
    "desktop-windows",
    "desktop-screenshot",
    "desktop-active-window",
];

/// 桌面只读观测操作(04 票):与浏览器操作用不同开关。
pub const DESKTOP_OPS: [&str; 3] = [
    "desktop-windows",
    "desktop-screenshot",
    "desktop-active-window",
];

/// 是否为桌面只读操作。
pub fn is_desktop_op(op: &str) -> bool {
    DESKTOP_OPS.contains(&op)
}

/// 一次自动化请求的终态(经 oneshot 送回挂起的 execute)。
#[derive(Debug)]
pub enum AutomationOutcome {
    /// 壳执行成功,payload 为业务结果(JSON)。
    Ok(serde_json::Value),
    /// 壳执行并显式报错(如 browserId 找不到、CDP 命令失败)。
    Failed(String),
}

/// 挂起的自动化请求表 + 等待超时(测试可注入)。
pub struct AutomationRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<AutomationOutcome>>>,
    timeout: RwLock<Duration>,
}

impl AutomationRegistry {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            timeout: RwLock::new(AUTOMATION_REQUEST_TIMEOUT),
        }
    }

    pub fn timeout(&self) -> Duration {
        *self.timeout.read().expect("automation timeout lock")
    }

    /// 测试缝:缩短等待超时(生产固定 15s)。
    pub fn set_timeout(&self, timeout: Duration) {
        *self.timeout.write().expect("automation timeout lock") = timeout;
    }

    /// 登记挂起项并取回 oneshot 接收端(execute 等待结果用)。
    pub async fn register(&self, request_id: &str) -> oneshot::Receiver<AutomationOutcome> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.to_string(), tx);
        rx
    }

    /// 回填结果;requestId 未知(已超时清理或从未存在)返回 false。
    pub async fn complete(&self, request_id: &str, outcome: AutomationOutcome) -> bool {
        let sender = self.pending.lock().await.remove(request_id);
        match sender {
            Some(sender) => sender.send(outcome).is_ok(),
            None => false,
        }
    }

    /// 超时/广播失败时移除挂起项(迟到的 result 将得到 400)。
    pub async fn abandon(&self, request_id: &str) {
        self.pending.lock().await.remove(request_id);
    }
}

impl Default for AutomationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 自动化请求广播事件(控制面:`session_id` 为空,session 订阅者不会收到)。
pub fn build_automation_request_event(
    request_id: &str,
    browser_id: Option<&str>,
    op: &str,
    params: &serde_json::Value,
) -> CompanionBroadcastEvent {
    CompanionBroadcastEvent {
        session_id: String::new(),
        event: serde_json::json!({
            "type": "browser-automation-request",
            "requestId": request_id,
            "browserId": browser_id,
            "op": op,
            "params": params,
        }),
    }
}

/// 自动化方法面的鉴权:仅回环 + Local Daemon Token(比通用 authorize 更严:
/// Pairing Token 一律 401,非回环来源一律 401)。纯函数,便于测试矩阵覆盖。
pub(crate) fn authorize_automation_request(
    app_data_dir: &Path,
    token: Option<&str>,
    peer: Option<SocketAddr>,
) -> Result<(), ApiError> {
    if !is_loopback_peer(peer) {
        return Err(ApiError::unauthorized(
            "Browser automation is only served to loopback callers",
        ));
    }
    let token = token.ok_or_else(|| ApiError::unauthorized("Missing token"))?;
    if !local_daemon_token::verify_local_daemon_token(app_data_dir, token) {
        return Err(ApiError::unauthorized(
            "Browser automation requires the Local Daemon Token",
        ));
    }
    Ok(())
}

/// 从既有 bearer 提取逻辑取 token(server.rs 的 extract_bearer_token 同形)。
fn bearer_token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route(
            "/browser-automation/execute",
            post(execute_browser_automation),
        )
        .route(
            "/browser-automation/result",
            post(submit_browser_automation_result),
        )
        .route(
            "/browser-automation/audit",
            axum::routing::get(list_browser_automation_audit),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationExecuteRequest {
    browser_id: Option<String>,
    op: String,
    #[serde(default)]
    params: serde_json::Value,
    /// 发起调用的会话(MCP server 经 `--session-id` 带入;缺省为无归属)。
    #[serde(default)]
    session_id: Option<String>,
    /// MCP 工具名(面向审批卡与审计;缺省用 op 兜底)。
    #[serde(default)]
    tool: Option<String>,
}

/// 审计记一笔（02 票）：失败吞掉，永不挡执行；401 鉴权失败不记（上下文不可信）。
fn audit_attempt(
    ctx: &ServerContext,
    op: &str,
    tool: Option<&str>,
    browser_id: Option<&str>,
    session_id: Option<&str>,
    ok: bool,
    error: Option<&str>,
) {
    if let Ok(db) = ctx.daemon.app.db.lock() {
        super::browser_audit::record_audit(
            &db,
            &super::browser_audit::AuditRecord {
                op,
                tool,
                browser_id,
                session_id,
                actor: "local",
                ok,
                decision: None,
                error,
            },
        );
    }
}

async fn execute_browser_automation(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AutomationExecuteRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = bearer_token_from_headers(&headers);
    authorize_automation_request(&ctx.daemon.app.app_data_dir, token.as_deref(), Some(peer))?;
    // 设置闸门(设置 → 浏览器控制 → 开启内置浏览器控制):关闭时会话不得驱动
    // 内置浏览器。403 文案直接面向用户,工具层会原样转述进对话。
    // 开关闸门:浏览器级操作看「浏览器控制」,桌面只读观测看「电脑控制」——
    // 允许智能体操作内置页面不等于允许它看整个桌面。
    let allowlist = {
        let config = ctx.daemon.app.config.lock().unwrap();
        let desktop_op = is_desktop_op(&body.op);
        let enabled = if desktop_op {
            config.computer_use.enabled
        } else {
            config.browser.enabled
        };
        if !enabled {
            let (detail, message) = if desktop_op {
                (
                    "gate: computer use disabled",
                    "电脑控制未开启:请在 设置 → 电脑控制 中打开后重试",
                )
            } else {
                (
                    "gate: browser control disabled",
                    "内置浏览器控制未开启:请在 设置 → 浏览器控制 中打开后重试",
                )
            };
            drop(config);
            audit_attempt(
                &ctx,
                &body.op,
                body.tool.as_deref(),
                body.browser_id.as_deref(),
                body.session_id.as_deref(),
                false,
                Some(detail),
            );
            return Err(ApiError::forbidden(message));
        }
        config.computer_use.allowlist.clone()
    };
    // 宿主进程家族(工单 11):自己的 pid + 外壳 pid(壳 spawn daemon 时经
    // CODEMUX_SHELL_PID 告知)+ 正在跑的驱动 pid。桌面回包筛查按这份身份硬拒
    // —— 没有标题的宿主窗口(自绘窗、驱动面板、DevTools)只靠标题挡不住。
    let protected = {
        let shell_pid = std::env::var("CODEMUX_SHELL_PID")
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok());
        let driver_pid = ctx.daemon.companion.inner.driver.pid().await;
        crate::computer_use::policy::ProtectedProcesses::host_family(shell_pid, driver_pid)
    };
    if !AUTOMATION_OPS.contains(&body.op.as_str()) {
        audit_attempt(
            &ctx,
            &body.op,
            body.tool.as_deref(),
            body.browser_id.as_deref(),
            body.session_id.as_deref(),
            false,
            Some("gate: unknown op"),
        );
        return Err(ApiError::bad_request(format!(
            "Unknown browser automation op: {}",
            body.op
        )));
    }

    // 电脑控制审批闸门(03 票):只读可「按会话记住」,输入动作一次一放行,
    // 敏感场景(登录/支付/验证码/密码/删除/关防护)强制人工确认。输入动作
    // 不吃权限档位 —— 闸门入参里根本没有档位可传。
    let tool = body.tool.as_deref().unwrap_or(&body.op);
    {
        let app = ctx.daemon.app.clone();
        let gate_input = crate::computer_use::approval::GateInput {
            session_id: body.session_id.as_deref(),
            tool,
            op: &body.op,
            params: &body.params,
            browser_id: body.browser_id.as_deref(),
        };
        if let Err(denied) = crate::computer_use::approval::gate(
            &app,
            &ctx.daemon.companion,
            &ctx.daemon.companion.inner.page_context,
            &gate_input,
        )
        .await
        {
            audit_attempt(
                &ctx,
                &body.op,
                Some(tool),
                body.browser_id.as_deref(),
                body.session_id.as_deref(),
                false,
                Some(&denied.message),
            );
            return Err(ApiError::forbidden(denied.message));
        }
    }

    let companion_state = ctx.daemon.companion.clone();
    let request_id = Uuid::new_v4().to_string();
    let rx = companion_state
        .inner
        .browser_automation
        .register(&request_id)
        .await;

    // 经既有 WS 广播机制下发(零订阅者 → 无壳客户端连接,快速失败)。
    let event = build_automation_request_event(
        &request_id,
        body.browser_id.as_deref(),
        &body.op,
        &body.params,
    );
    let broadcast = companion_state.inner.event_tx.send(event);
    if broadcast.is_err() {
        companion_state
            .inner
            .browser_automation
            .abandon(&request_id)
            .await;
        audit_attempt(
            &ctx,
            &body.op,
            Some(tool),
            body.browser_id.as_deref(),
            body.session_id.as_deref(),
            false,
            Some("no shell client"),
        );
        return Err(ApiError::service_unavailable(
            "No shell browser-automation client is connected",
        ));
    }

    let timeout = companion_state.inner.browser_automation.timeout();
    let waited = tokio::time::timeout(timeout, rx).await;
    let outcome = match waited {
        Ok(Ok(outcome)) => Some(outcome),
        // 壳在回填前掉线:oneshot 发送端被移除,按失败收口。
        Ok(Err(_)) => Some(AutomationOutcome::Failed(
            "Browser automation result channel dropped before the result arrived".to_string(),
        )),
        Err(_) => None,
    };
    let Some(outcome) = outcome else {
        companion_state
            .inner
            .browser_automation
            .abandon(&request_id)
            .await;
        audit_attempt(
            &ctx,
            &body.op,
            Some(tool),
            body.browser_id.as_deref(),
            body.session_id.as_deref(),
            false,
            Some("timeout waiting for shell result"),
        );
        return Err(ApiError::gateway_timeout(format!(
            "Browser automation request timed out after {}ms",
            timeout.as_millis()
        )));
    };

    // 桌面只读回包按可操作范围筛查(需求 14、工单 11):不可操作的窗口(按
    // 名称或按宿主进程身份)既不截图也不列举。
    let outcome = match outcome {
        AutomationOutcome::Ok(payload) if is_desktop_op(&body.op) => {
            match crate::computer_use::policy::screen_desktop_payload(
                &body.op, &payload, &allowlist, &protected,
            ) {
                Ok(filtered) => AutomationOutcome::Ok(filtered),
                Err(refusal) => AutomationOutcome::Failed(refusal),
            }
        }
        other => other,
    };

    match &outcome {
        AutomationOutcome::Ok(payload) => {
            // snapshot 回包顺便喂页面上下文缓存(审批敏感判定用)。
            if body.op == "snapshot" {
                companion_state
                    .inner
                    .page_context
                    .record_snapshot(body.browser_id.as_deref(), payload);
            }
            audit_attempt(
                &ctx,
                &body.op,
                Some(tool),
                body.browser_id.as_deref(),
                body.session_id.as_deref(),
                true,
                None,
            )
        }
        AutomationOutcome::Failed(error) => audit_attempt(
            &ctx,
            &body.op,
            Some(tool),
            body.browser_id.as_deref(),
            body.session_id.as_deref(),
            false,
            Some(error),
        ),
    }
    Ok(Json(match outcome {
        AutomationOutcome::Ok(payload) => serde_json::json!({
            "ok": true,
            "requestId": request_id,
            "payload": payload,
        }),
        AutomationOutcome::Failed(error) => serde_json::json!({
            "ok": false,
            "requestId": request_id,
            "error": error,
        }),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationResultRequest {
    request_id: String,
    ok: bool,
    #[serde(default)]
    payload: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
}

async fn submit_browser_automation_result(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AutomationResultRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = bearer_token_from_headers(&headers);
    authorize_automation_request(&ctx.daemon.app.app_data_dir, token.as_deref(), Some(peer))?;

    let outcome = if body.ok {
        AutomationOutcome::Ok(body.payload.unwrap_or(serde_json::Value::Null))
    } else {
        AutomationOutcome::Failed(
            body.error
                .unwrap_or_else(|| "Browser automation failed".to_string()),
        )
    };
    let delivered = ctx
        .daemon
        .companion
        .inner
        .browser_automation
        .complete(&body.request_id, outcome)
        .await;
    if !delivered {
        return Err(ApiError::bad_request(format!(
            "Unknown browser automation requestId: {}",
            body.request_id
        )));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct AuditListQuery {
    #[serde(default)]
    limit: Option<i64>,
}

async fn list_browser_automation_audit(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AuditListQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = bearer_token_from_headers(&headers);
    authorize_automation_request(&ctx.daemon.app.app_data_dir, token.as_deref(), Some(peer))?;
    let entries = {
        let db = ctx
            .daemon
            .app
            .db
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        super::browser_audit::list_automation_audit(&db, query.limit.unwrap_or(50))
            .map_err(ApiError::internal)?
    };
    Ok(Json(serde_json::json!({ "ok": true, "entries": entries })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::sync::OnceLock;

    fn temp_app_data() -> std::path::PathBuf {
        static COUNTER: OnceLock<StdMutex<u64>> = OnceLock::new();
        let counter = COUNTER.get_or_init(|| StdMutex::new(0));
        let mut guard = counter.lock().unwrap();
        *guard += 1;
        let dir = std::env::temp_dir().join(format!("codemux-browser-automation-test-{}", *guard));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_ops_are_rejected() {
        for op in ["aria-snapshot", "", "EVAL", "screenshots"] {
            assert!(
                !AUTOMATION_OPS.contains(&op),
                "op {op:?} 不在合法集合内,应被 400 拒绝"
            );
        }
        for op in AUTOMATION_OPS {
            assert!(AUTOMATION_OPS.contains(&op));
        }
    }

    #[test]
    fn element_ops_are_accepted() {
        for op in ["snapshot", "click", "type", "scroll", "select"] {
            assert!(AUTOMATION_OPS.contains(&op), "op {op:?} 应为合法自动化操作");
        }
    }

    #[test]
    fn loopback_local_daemon_token_is_accepted() {
        let dir = temp_app_data();
        let token = local_daemon_token::ensure_local_daemon_token(&dir, false).unwrap();
        authorize_automation_request(&dir, Some(&token), Some("127.0.0.1:5000".parse().unwrap()))
            .expect("回环 + Local Daemon Token 应放行");
        // 无 ConnectInfo(如服务内调用)等价按回环处理。
        authorize_automation_request(&dir, Some(&token), None).expect("缺省 peer 视为回环,应放行");
    }

    #[test]
    fn pairing_token_is_rejected_even_on_loopback() {
        let dir = temp_app_data();
        let _ = local_daemon_token::ensure_local_daemon_token(&dir, false).unwrap();
        let error = authorize_automation_request(
            &dir,
            Some("pairing-style-token"),
            Some("127.0.0.1:5000".parse().unwrap()),
        )
        .expect_err("Pairing Token 不是 Local Daemon Token,必须 401");
        assert_eq!(error.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn non_loopback_peer_is_rejected_even_with_local_token() {
        let dir = temp_app_data();
        let token = local_daemon_token::ensure_local_daemon_token(&dir, false).unwrap();
        let error = authorize_automation_request(
            &dir,
            Some(&token),
            Some("10.0.0.8:5100".parse().unwrap()),
        )
        .expect_err("非回环来源必须 401");
        assert_eq!(error.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn missing_or_wrong_token_is_rejected() {
        let dir = temp_app_data();
        let _ = local_daemon_token::ensure_local_daemon_token(&dir, false).unwrap();
        let peer = Some("127.0.0.1:5000".parse().unwrap());
        let missing =
            authorize_automation_request(&dir, None, peer).expect_err("缺 token 必须 401");
        assert_eq!(missing.status(), axum::http::StatusCode::UNAUTHORIZED);
        let wrong = authorize_automation_request(&dir, Some("not-the-token"), peer)
            .expect_err("错 token 必须 401");
        assert_eq!(wrong.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn registry_roundtrip_and_unknown_ids() {
        let registry = AutomationRegistry::new();
        assert_eq!(registry.timeout(), AUTOMATION_REQUEST_TIMEOUT);
        registry.set_timeout(Duration::from_millis(50));
        assert_eq!(registry.timeout(), Duration::from_millis(50));

        let rx = registry.register("req-1").await;
        assert!(
            !registry
                .complete("unknown", AutomationOutcome::Ok(serde_json::json!(1)))
                .await,
            "未知 requestId 的 result 应返回 false(对应 400)"
        );
        registry
            .complete("req-1", AutomationOutcome::Ok(serde_json::json!({"v": 42})))
            .await;
        match rx.await.expect("oneshot 应被唤醒") {
            AutomationOutcome::Ok(payload) => assert_eq!(payload["v"], 42),
            AutomationOutcome::Failed(_) => panic!("应为 Ok 结果"),
        }

        let rx = registry.register("req-2").await;
        drop(rx);
        assert!(
            !registry
                .complete("req-2", AutomationOutcome::Failed("x".into()))
                .await,
            "等待端已丢弃时 complete 返回 false"
        );
    }

    #[test]
    fn automation_request_event_uses_empty_session_id() {
        let event = build_automation_request_event(
            "req-1",
            Some("browser-1"),
            "eval",
            &serde_json::json!({ "code": "1+1" }),
        );
        assert_eq!(event.session_id, "", "控制面事件 session_id 必须为空");
        assert_eq!(event.event["type"], "browser-automation-request");
        assert_eq!(event.event["requestId"], "req-1");
        assert_eq!(event.event["browserId"], "browser-1");
        assert_eq!(event.event["op"], "eval");
        assert_eq!(event.event["params"]["code"], "1+1");
    }
    #[test]
    fn audit_table_exists_after_initialize() {
        let conn = rusqlite::Connection::open_in_memory().expect("内存库");
        crate::db::schema::initialize_database(&conn).expect("建表");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM browser_automation_audit", [], |row| {
                row.get(0)
            })
            .expect("审计表应存在");
        assert_eq!(count, 0);
    }
}
