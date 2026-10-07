//! 电脑控制审批闸门(工单 03):daemon 侧的统一放行/拦截裁决。
//!
//! 五级链路里只有本模块问人:各智能体原生 MCP 权限门管的是「模型能不能
//! 调这个工具」,本闸门管的是「这一步动作现在能不能做」,粒度是
//! 单步放行 / 按会话记住(只读)/ 拦截,五个智能体共用一份裁决。
//!
//! 事件走会话流(与既有 `permission_requested` 同路径):审批卡渲染在
//! 会话输入框上方,只有该会话的订阅者会收到。没人应答时按超时拒绝 ——
//! 无人值守一律不放行。
//!
//! 与壳的自动化接缝同款鉴权:仅回环 + Local Daemon Token。

use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::companion::browser_audit::{self, AuditRecord};
use crate::companion::local_daemon_token;
use crate::companion::server::{is_loopback_peer, ApiError, ServerContext};
use crate::companion::state::{CompanionBroadcastEvent, CompanionState};

use super::guard::{self, ApprovalChoice, GateDecision, RiskClass};
use super::page_context::PageContextCache;

/// 参数里属于秘密的值:审计与审批卡只存/展示长度,不落原文(需求 19)。
///
/// `keyCode` 也算:单个按键不敏感,但按键序列连起来就是输入内容。
const SECRET_PARAM_KEYS: [&str; 3] = ["text", "keys", "keyCode"];

/// 递归脱敏:秘密键的字符串值换成 `<已脱敏 N 字>`。
pub fn redact_params(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let redacted = if SECRET_PARAM_KEYS.contains(&key.as_str()) {
                        match item.as_str() {
                            Some(text) => serde_json::Value::String(format!(
                                "<已脱敏 {} 字>",
                                text.chars().count()
                            )),
                            None => item.clone(),
                        }
                    } else {
                        redact_params(item)
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(redact_params).collect())
        }
        other => other.clone(),
    }
}

/// 面向模型与审批卡的一句话动作摘要(不含输入内容)。
pub fn action_summary(op: &str, params: &serde_json::Value) -> String {
    let element = params.get("elementId").and_then(|value| value.as_str());
    match op {
        "list" => "列出内置浏览器打开的页面".to_string(),
        "snapshot" => "读取页面快照(编号截图加元素列表)".to_string(),
        "screenshot" => "截取页面截图".to_string(),
        "click" => match element {
            Some(id) => format!("点击元素 {id}"),
            None => "点击页面".to_string(),
        },
        "type" => {
            let chars = params
                .get("text")
                .and_then(|value| value.as_str())
                .map(|text| text.chars().count())
                .unwrap_or(0);
            match element {
                Some(id) => format!("在元素 {id} 输入 {chars} 个字符"),
                None => format!("输入 {chars} 个字符"),
            }
        }
        "select" => match element {
            Some(id) => format!("在元素 {id} 选择下拉项"),
            None => "选择下拉项".to_string(),
        },
        "scroll" => match element {
            Some(id) => format!("滚动元素 {id}"),
            None => "滚动页面".to_string(),
        },
        "eval" => "在页面内执行 JavaScript".to_string(),
        "input" => "向页面发送键鼠事件".to_string(),
        "cdp" => {
            let method = params
                .get("method")
                .and_then(|value| value.as_str())
                .unwrap_or("?");
            format!("调用 CDP 命令 {method}")
        }
        "desktop-windows" => "列出桌面窗口".to_string(),
        "desktop-screenshot" => "截取桌面或窗口".to_string(),
        "desktop-active-window" => "读取活动窗口信息".to_string(),
        other => format!("执行 {other}"),
    }
}

/// 一次闸门判定所需的输入。
pub struct GateInput<'a> {
    pub session_id: Option<&'a str>,
    pub tool: &'a str,
    pub op: &'a str,
    pub params: &'a serde_json::Value,
    pub browser_id: Option<&'a str>,
}

/// 闸门裁决结果:Ok(()) 放行,Err(文案) 拦截(文案面向模型)。
pub struct GateDenied {
    pub message: String,
}

impl GateDenied {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// 敏感判定:浏览器级看快照留下的页面上下文(密码框/URL/标签),
/// 再叠加参数原文(桌面与驱动级只有参数可看)。
fn detect_sensitive(
    page_context: &PageContextCache,
    input: &GateInput<'_>,
) -> Option<&'static str> {
    let element_id = input
        .params
        .get("elementId")
        .and_then(|value| value.as_str());
    page_context
        .sensitivity(input.browser_id, element_id)
        .or_else(|| {
            let params_text = input.params.to_string();
            guard::sensitivity_of(&[input.tool, input.op, params_text.as_str()])
        })
}

/// 统一闸门:分类 → 敏感判定 → 粒度决策 → (必要时)等人工放行 → 审计。
///
/// 审计在这里落两笔:一次「等待审批」的决策记录,以及放行后由调用方
/// 补的执行结果(调用方仍走自己的 `audit_attempt`)。
pub async fn gate(
    app: &Arc<crate::AppState>,
    companion: &CompanionState,
    page_context: &PageContextCache,
    input: &GateInput<'_>,
) -> Result<(), GateDenied> {
    let class = guard::classify(input.op);
    let sensitive = detect_sensitive(page_context, input);
    let key = guard::session_memory_key(input.op);
    let remembered = input
        .session_id
        .is_some_and(|session_id| companion.inner.approvals.is_remembered(session_id, &key));

    // 步数护栏(需求 22):额度用尽直接收口,不再打扰用户点放行。
    let max_steps = app.config.lock().unwrap().computer_use.max_steps;
    let step_scope = input.session_id.map(|session_id| {
        (
            session_id.to_string(),
            companion.turn_epoch(session_id).unwrap_or(0),
        )
    });

    let decision = guard::decide(class, sensitive, remembered);
    let GateDecision::Ask { rememberable } = decision else {
        charge_step(app, companion, input, &step_scope, max_steps, class)?;
        return Ok(());
    };

    if class == RiskClass::Input {
        if let Some((session_id, epoch)) = &step_scope {
            let used = companion.inner.step_budget.used_in_turn(session_id, *epoch);
            if max_steps > 0 && used >= max_steps {
                record_decision(app, input, sensitive, "step-limit", false, Some("步数到顶"));
                return Err(GateDenied::new(format!(
                    "本回合的电脑控制步数已到上限({max_steps} 步,已用 {used} 步)。停下来说明已完成什么、还剩什么,等用户给新指令或调高上限(设置 → 电脑控制 → 步数上限)。"
                )));
            }
        }
    }

    let request_id = Uuid::new_v4().to_string();
    let summary = action_summary(input.op, input.params);
    let redacted = redact_params(input.params);
    let spec = ApprovalRequestSpec {
        request_id: request_id.clone(),
        session_id: input.session_id.map(str::to_string),
        tool: input.tool.to_string(),
        op: input.op.to_string(),
        summary: summary.clone(),
        risk: class,
        sensitive,
        rememberable,
    };

    let rx = companion.inner.approvals.register(&request_id).await;
    let broadcast = companion
        .inner
        .event_tx
        .send(build_approval_request_event(&spec, &redacted));
    if broadcast.is_err() {
        companion.inner.approvals.abandon(&request_id).await;
        record_decision(
            app,
            input,
            sensitive,
            "no-ui",
            false,
            Some("没有订阅该会话的审批端"),
        );
        return Err(GateDenied::new(format!(
            "「{}」需要人工放行,但没有订阅该会话的界面可应答(审批超时按拒绝处理)。",
            summary
        )));
    }

    let timeout = companion.inner.approvals.timeout();
    let choice = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(choice)) => choice,
        Ok(Err(_)) => {
            record_decision(
                app,
                input,
                sensitive,
                "dropped",
                false,
                Some("审批通道关闭"),
            );
            return Err(GateDenied::new(format!(
                "「{summary}」的放行界面已断开,按拒绝处理。"
            )));
        }
        Err(_) => {
            companion.inner.approvals.abandon(&request_id).await;
            record_decision(
                app,
                input,
                sensitive,
                "timeout",
                false,
                Some("等待人工放行超时"),
            );
            let _ = companion.inner.event_tx.send(build_approval_resolved_event(
                &spec.request_id,
                spec.session_id.as_deref(),
                "timeout",
            ));
            return Err(GateDenied::new(format!(
                "「{}」等待人工放行超时({} 秒),按拒绝处理。",
                summary,
                timeout.as_secs()
            )));
        }
    };

    let _ = companion.inner.event_tx.send(build_approval_resolved_event(
        &spec.request_id,
        spec.session_id.as_deref(),
        choice.as_str(),
    ));

    match choice {
        ApprovalChoice::Reject => {
            record_decision(app, input, sensitive, "reject", false, Some("用户拦截"));
            Err(GateDenied::new(format!(
                "用户拦截了「{summary}」。不要重试这一步;如确有必要,先向用户说明再等新指令。"
            )))
        }
        ApprovalChoice::Always => {
            // 「按会话记住」只在 rememberable 时生效:输入动作与敏感场景
            // 即便界面给了 always 也按单步放行处理。
            let remembered = rememberable;
            if remembered {
                if let Some(session_id) = input.session_id {
                    companion
                        .inner
                        .approvals
                        .remember_for_session(session_id, &key);
                }
            }
            record_decision(
                app,
                input,
                sensitive,
                if remembered {
                    "allow-session"
                } else {
                    "allow-once"
                },
                true,
                None,
            );
            Ok(())
        }
        ApprovalChoice::Once => {
            record_decision(app, input, sensitive, "allow-once", true, None);
            charge_step(app, companion, input, &step_scope, max_steps, class)
        }
    }
}

/// 放行的输入动作记一步;到顶即拒绝(即便刚被放行 —— 上限优先于单步放行)。
fn charge_step(
    app: &Arc<crate::AppState>,
    companion: &CompanionState,
    input: &GateInput<'_>,
    step_scope: &Option<(String, u64)>,
    max_steps: u32,
    class: RiskClass,
) -> Result<(), GateDenied> {
    if class != RiskClass::Input {
        return Ok(());
    }
    let Some((session_id, epoch)) = step_scope else {
        return Ok(());
    };
    match companion
        .inner
        .step_budget
        .charge(session_id, *epoch, max_steps)
    {
        Ok(_) => Ok(()),
        Err(used) => {
            record_decision(app, input, None, "step-limit", false, Some("步数到顶"));
            Err(GateDenied::new(format!(
                "本回合的电脑控制步数已到上限({max_steps} 步,已用 {used} 步)。停下来汇报进展,等用户给新指令或调高上限。"
            )))
        }
    }
}

/// 审批决策落审计(失败吞掉,永不挡执行)。
fn record_decision(
    app: &Arc<crate::AppState>,
    input: &GateInput<'_>,
    sensitive: Option<&str>,
    decision: &str,
    ok: bool,
    error: Option<&str>,
) {
    let note = match (sensitive, error) {
        (Some(scene), Some(error)) => Some(format!("敏感场景:{scene};{error}")),
        (Some(scene), None) => Some(format!("敏感场景:{scene}")),
        (None, Some(error)) => Some(error.to_string()),
        (None, None) => None,
    };
    if let Ok(db) = app.db.lock() {
        browser_audit::record_audit(
            &db,
            &AuditRecord {
                op: input.op,
                tool: Some(input.tool),
                browser_id: input.browser_id,
                session_id: input.session_id,
                actor: "local",
                ok,
                decision: Some(decision),
                error: note.as_deref(),
            },
        );
    }
}

/// 审批请求事件(会话流)。
#[derive(Debug, Clone)]
pub struct ApprovalRequestSpec {
    pub request_id: String,
    pub session_id: Option<String>,
    pub tool: String,
    pub op: String,
    pub summary: String,
    pub risk: RiskClass,
    pub sensitive: Option<&'static str>,
    pub rememberable: bool,
}

pub fn build_approval_request_event(
    spec: &ApprovalRequestSpec,
    redacted_params: &serde_json::Value,
) -> CompanionBroadcastEvent {
    CompanionBroadcastEvent {
        session_id: spec.session_id.clone().unwrap_or_default(),
        event: serde_json::json!({
            "type": "computer-use-approval-request",
            "requestId": spec.request_id,
            "sessionId": spec.session_id,
            "tool": spec.tool,
            "op": spec.op,
            "summary": spec.summary,
            "risk": spec.risk,
            "sensitive": spec.sensitive,
            "rememberable": spec.rememberable,
            "params": redacted_params,
        }),
    }
}

/// 审批已决(超时/放行/拦截)事件:其余端据此收起卡片。
pub fn build_approval_resolved_event(
    request_id: &str,
    session_id: Option<&str>,
    decision: &str,
) -> CompanionBroadcastEvent {
    CompanionBroadcastEvent {
        session_id: session_id.unwrap_or_default().to_string(),
        event: serde_json::json!({
            "type": "computer-use-approval-resolved",
            "requestId": request_id,
            "sessionId": session_id,
            "decision": decision,
        }),
    }
}

/// 电脑控制各端点共用的鉴权:仅回环 + Local Daemon Token。
///
/// 比通用 `authorize` 严的两条:配对设备一律 401(治理面不给远程设备);
/// 非回环来源一律 401。
pub(crate) fn authorize_local_request(
    app_data_dir: &std::path::Path,
    headers: &HeaderMap,
    peer: Option<std::net::SocketAddr>,
) -> Result<(), ApiError> {
    if !is_loopback_peer(peer) {
        return Err(ApiError::unauthorized(
            "Computer-use endpoints are only served to loopback callers",
        ));
    }
    let token = bearer_token_from_headers(headers)
        .ok_or_else(|| ApiError::unauthorized("Missing token"))?;
    if !local_daemon_token::verify_local_daemon_token(app_data_dir, &token) {
        return Err(ApiError::unauthorized(
            "Computer-use endpoints require the Local Daemon Token",
        ));
    }
    Ok(())
}

fn bearer_token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router.route("/computer-use/approval", post(submit_approval_decision))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalDecisionRequest {
    request_id: String,
    choice: ApprovalChoice,
}

async fn submit_approval_decision(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ApprovalDecisionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize_local_request(&ctx.daemon.app.app_data_dir, &headers, Some(peer))?;
    let delivered = ctx
        .daemon
        .companion
        .inner
        .approvals
        .resolve(&body.request_id, body.choice)
        .await;
    if !delivered {
        return Err(ApiError::bad_request(format!(
            "Unknown or already settled computer-use approval requestId: {}",
            body.request_id
        )));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redaction_hides_secret_values_but_keeps_length() {
        let redacted = redact_params(&json!({
            "elementId": "e3",
            "text": "hunter2",
            "submit": true,
        }));
        assert_eq!(redacted["elementId"], "e3");
        assert_eq!(redacted["text"], "<已脱敏 7 字>");
        assert_eq!(redacted["submit"], true);
    }

    #[test]
    fn redaction_walks_nested_structures() {
        let redacted = redact_params(&json!({
            "events": [{ "type": "keyDown", "keys": "secret-sequence", "keyCode": "KeyA" }],
        }));
        assert_eq!(redacted["events"][0]["keys"], "<已脱敏 15 字>");
        assert_eq!(redacted["events"][0]["keyCode"], "<已脱敏 4 字>");
        assert_eq!(redacted["events"][0]["type"], "keyDown");
    }

    #[test]
    fn summaries_never_leak_typed_text() {
        let summary = action_summary("type", &json!({ "elementId": "e7", "text": "p@ssw0rd123" }));
        assert_eq!(summary, "在元素 e7 输入 11 个字符");
        assert!(!summary.contains("p@ssw0rd123"));
    }

    #[test]
    fn summaries_name_the_action() {
        assert_eq!(
            action_summary("click", &json!({ "elementId": "e3" })),
            "点击元素 e3"
        );
        assert_eq!(action_summary("scroll", &json!({})), "滚动页面");
        assert_eq!(
            action_summary("cdp", &json!({ "method": "DOM.getDocument" })),
            "调用 CDP 命令 DOM.getDocument"
        );
        assert_eq!(
            action_summary("desktop-screenshot", &json!({})),
            "截取桌面或窗口"
        );
    }

    #[test]
    fn approval_request_event_targets_the_session_stream() {
        let spec = ApprovalRequestSpec {
            request_id: "req-1".to_string(),
            session_id: Some("session-1".to_string()),
            tool: "browser_click".to_string(),
            op: "click".to_string(),
            summary: "点击元素 e3".to_string(),
            risk: RiskClass::Input,
            sensitive: None,
            rememberable: false,
        };
        let event = build_approval_request_event(&spec, &json!({ "elementId": "e3" }));
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.event["type"], "computer-use-approval-request");
        assert_eq!(event.event["requestId"], "req-1");
        assert_eq!(event.event["risk"], "input");
        assert_eq!(event.event["rememberable"], false);
        assert_eq!(event.event["params"]["elementId"], "e3");
    }

    #[test]
    fn resolved_event_clears_the_card_for_other_clients() {
        let event = build_approval_resolved_event("req-1", Some("session-1"), "reject");
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.event["type"], "computer-use-approval-resolved");
        assert_eq!(event.event["decision"], "reject");
    }

    #[test]
    fn authorization_matrix_matches_the_automation_seam() {
        let dir =
            std::env::temp_dir().join(format!("codemux-approval-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let token = local_daemon_token::ensure_local_daemon_token(&dir, false).unwrap();
        let with_token = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            headers
        };
        authorize_local_request(
            &dir,
            &with_token(&token),
            Some("127.0.0.1:5000".parse().unwrap()),
        )
        .expect("回环 + Local Token 应放行");
        assert!(authorize_local_request(
            &dir,
            &with_token(&token),
            Some("10.1.2.3:5000".parse().unwrap())
        )
        .is_err());
        assert!(authorize_local_request(&dir, &with_token("pairing-token"), None).is_err());
        assert!(authorize_local_request(&dir, &HeaderMap::new(), None).is_err());
    }
}
