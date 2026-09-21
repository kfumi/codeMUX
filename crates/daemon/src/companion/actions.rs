use std::sync::Arc;
use std::time::Duration;

use crate::agent::commands::{
    ensure_agent_session_for_companion, interrupt_agent_session_for_companion,
    send_command_to_session, AgentState,
};
use crate::agent::session_lifecycle::start_agent_session_core;
use crate::agent::sidecar_events::null_sink;
use crate::agent_runtime::opencode::OpenCodeRuntime;
use crate::companion::CompanionState;
use crate::config::types::AgentKind;
use crate::daemon::DaemonState;
use crate::db::operations;
use crate::AppState;

/// warm send 派发后等待 sidecar 受理(user_message / 终态事件)的上限。
/// 正常 warm 路径该事件在毫秒级到达;超时说明命令在 daemon↔sidecar 管道里
/// 丢失或 sidecar 命令循环已停摆 —— 此刻继续等待只会让会话永久卡在
/// 「运行中」(2026-09-20 事故),不如落一条 error 终态解堵。
const SEND_ACK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct CompanionSettingsUpdate {
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_config: serde_json::Value,
    pub plan_mode: String,
}

pub fn resolve_session_cwd(state: &AppState, session_id: &str) -> Result<String, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    let session = operations::get_session(&db, session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Session not found".to_string())?;

    if let Some(project_id) = session.project_id {
        let project_path: Option<String> = db
            .query_row(
                "SELECT path FROM projects WHERE id = ?1",
                [project_id.as_str()],
                |row| row.get(0),
            )
            .ok();
        if let Some(path) = project_path {
            return Ok(path);
        }
    }

    crate::agent::commands::home_dir()
        .map(|path| path.display().to_string())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActiveSidecarSendDecision {
    Steer,
    Enqueue,
    StartTurn,
}

pub(crate) fn decide_active_sidecar_send(
    delivery: Option<&str>,
    turn_active: bool,
) -> ActiveSidecarSendDecision {
    if delivery == Some("steer") {
        return ActiveSidecarSendDecision::Steer;
    }
    if turn_active {
        return ActiveSidecarSendDecision::Enqueue;
    }
    ActiveSidecarSendDecision::StartTurn
}

pub async fn send_companion_message(
    daemon: &DaemonState,
    session_id: &str,
    prompt: &str,
    input_payload: Option<serde_json::Value>,
    delivery: Option<&str>,
    request_id: Option<&str>,
) -> Result<(), String> {
    send_companion_message_owned(
        daemon.app.clone(),
        daemon.agent.clone(),
        daemon.companion.clone(),
        daemon.roots.clone(),
        session_id,
        prompt,
        input_payload,
        delivery,
        request_id,
    )
    .await
}

/// Owned-handle variant so the queued-message dispatch task can stay `'static`.
// 9 个参数是「5 个 owned 句柄 + 4 个消息参数」的扁平列表,拆成结构体只会
// 在调用点重复组装;保持签名稳定,故此处豁免参数数量 lint。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_companion_message_owned(
    app_state: Arc<AppState>,
    agent_state: Arc<AgentState>,
    companion_state: Arc<CompanionState>,
    roots: crate::paths::PathRoots,
    session_id: &str,
    prompt: &str,
    input_payload: Option<serde_json::Value>,
    delivery: Option<&str>,
    request_id: Option<&str>,
) -> Result<(), String> {
    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let sidecar_running = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.contains_key(session_id)
    };
    let perf_started = std::time::Instant::now();
    log::info!(
        target: "perf",
        "[perf] send received session_id={} mode={} prompt_len={}",
        session_id,
        if sidecar_running { "warm" } else { "cold" },
        prompt.len(),
    );

    if sidecar_running {
        // 会话未收尾即排队：父回合活跃之外，后台子智能体仍在运行、或刚全部
        // 结束等待父进程汇总回合的窗口，都算忙（decide 见
        // ActiveSidecarSendDecision）。DB 查询兜底内存态丢失（如 daemon 重启
        // 后 sidecar 复用）的场景。
        let db_running = {
            let db = app_state
                .db
                .lock()
                .map_err(|_| "Database lock poisoned".to_string())?;
            operations::has_running_session_subagents(&db, session_id).map_err(|e| e.to_string())?
        };
        let flow_busy = companion_state.is_turn_active(session_id)
            || companion_state.is_continuation_pending(session_id)
            || db_running;
        match decide_active_sidecar_send(delivery, flow_busy) {
            ActiveSidecarSendDecision::Steer => {
                let mut cmd =
                    OpenCodeRuntime::send_input_command(session_id, prompt.to_string(), None);
                if let Some(input_payload) = input_payload {
                    cmd["inputPayload"] = input_payload;
                }
                cmd["delivery"] = serde_json::Value::String("steer".to_string());
                if let Some(request_id) = request_id {
                    cmd["requestId"] = serde_json::Value::String(request_id.to_string());
                }
                let result = send_command_to_session(&agent_state, session_id, cmd).await;
                log::info!(target: "perf", "[perf] steer dispatched elapsed_ms={} ok={}", perf_started.elapsed().as_millis(), result.is_ok());
                return result;
            }
            ActiveSidecarSendDecision::Enqueue => {
                companion_state.enqueue_message(session_id, prompt.to_string(), input_payload);
                log::info!(target: "perf", "[perf] send ENQUEUED (turn busy) session_id={session_id} — dispatched when current turn finishes");
                return Ok(());
            }
            ActiveSidecarSendDecision::StartTurn => {
                let turn_epoch = companion_state.mark_turn_active(session_id);
                let mut cmd =
                    OpenCodeRuntime::send_input_command(session_id, prompt.to_string(), None);
                if let Some(input_payload) = input_payload {
                    cmd["inputPayload"] = input_payload;
                }
                let result = send_command_to_session(&agent_state, session_id, cmd).await;
                match &result {
                    Err(_) => {
                        let _ = companion_state.finish_turn(session_id);
                    }
                    Ok(()) => {
                        // 命令进了 stdin 通道 ≠ sidecar 真正受理。历史上命令
                        // 会在 daemon↔sidecar 管道里无痕蒸发(2026-09-20 rewind
                        // 后 warm resend 事故),turn 从此永远 active、后续消息
                        // 永远入队。这里武装 ack 看门狗:超时仍无 sidecar 的
                        // user_message/终态事件(代次未变)就合成 error 终态,
                        // 把 turn 解堵。sidecar 受理时 events.rs 的 user_message
                        // 分支会再次 mark_turn_active 使代次前移,看门狗自动失效。
                        spawn_send_ack_watchdog(
                            app_state.clone(),
                            agent_state.clone(),
                            companion_state.clone(),
                            roots.clone(),
                            session_id.to_string(),
                            turn_epoch,
                        );
                    }
                }
                log::info!(target: "perf", "[perf] warm send dispatched elapsed_ms={} ok={}", perf_started.elapsed().as_millis(), result.is_ok());
                return result;
            }
        }
    }

    companion_state.mark_turn_active(session_id);
    let cwd = resolve_session_cwd(&app_state, session_id)?;
    let reasoning_effort = {
        let db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .and_then(|session| session.reasoning_effort)
    };

    let result = start_agent_session_core(
        app_state,
        agent_state,
        companion_state.clone(),
        roots,
        session_id.to_string(),
        prompt.to_string(),
        cwd,
        null_sink(),
        reasoning_effort,
        input_payload,
        None,
        false,
    )
    .await;
    log::info!(target: "perf", "[perf] cold start+send finished elapsed_ms={} ok={}", perf_started.elapsed().as_millis(), result.is_ok());
    if result.is_err() {
        let _ = companion_state.finish_turn(session_id);
    }
    result
}

/// warm send 的受理看门狗:`SEND_ACK_TIMEOUT` 后若该回合仍是派发时武装的
/// 同一代次(即 sidecar 从未发出 user_message/终态事件),合成一条 error
/// 域事件走标准 ingest 路径 —— 落库、finish_turn、广播给客户端,与 sidecar
/// 自身失败的表现完全一致。
fn spawn_send_ack_watchdog(
    app_state: Arc<AppState>,
    agent_state: Arc<AgentState>,
    companion_state: Arc<CompanionState>,
    roots: crate::paths::PathRoots,
    session_id: String,
    armed_epoch: u64,
) {
    tokio::spawn(async move {
        tokio::time::sleep(SEND_ACK_TIMEOUT).await;
        if !companion_state.is_turn_active(&session_id) {
            return;
        }
        if companion_state.turn_epoch(&session_id) != Some(armed_epoch) {
            // sidecar 已受理(user_message 使代次前移)或回合已换新 —— 不干预。
            return;
        }
        log::warn!(
            target: "agent",
            "Warm send for session_id={} was never acknowledged by the sidecar within {:?}; failing the turn so it cannot stay running forever",
            session_id,
            SEND_ACK_TIMEOUT
        );
        let raw_event = serde_json::json!({
            "type": "error",
            "session_id": session_id,
            "subtype": "failed",
            "error": "消息未能送达智能体运行时(命令通道无响应),已自动终止本回合;请重试或重启会话",
        })
        .to_string();
        let broadcast_events = {
            let state_for_persist = app_state.clone();
            let raw_event = raw_event.clone();
            tokio::task::spawn_blocking(move || {
                crate::agent::timeline_persist::ingest_sidecar_event(&state_for_persist, &raw_event)
            })
            .await
            .unwrap_or_default()
        };
        crate::companion::handle_sidecar_event_for_companion(
            &app_state,
            &agent_state,
            &companion_state,
            &roots,
            broadcast_events,
        );
    });
}

fn validate_companion_agent_kind(current: AgentKind, requested: AgentKind) -> Result<(), String> {
    if current != requested {
        return Err("会话创建后不能更换智能体种类".to_string());
    }
    Ok(())
}

pub async fn update_companion_settings(
    daemon: &DaemonState,
    session_id: &str,
    update: CompanionSettingsUpdate,
) -> Result<operations::Session, String> {
    let app_state = &daemon.app;
    let agent_state = &daemon.agent;
    let companion_state = &daemon.companion;

    crate::agent::commands::reject_read_only_session(app_state, session_id)?;
    if companion_state.is_turn_active(session_id) {
        return Err("会话正在运行，请等待处理完成后再修改设置".to_string());
    }
    if !update.permission_config.is_object() {
        return Err("permissionConfig 必须是对象".to_string());
    }
    if !matches!(update.plan_mode.as_str(), "on" | "off") {
        return Err("planMode 必须是 on 或 off".to_string());
    }

    let current = {
        let db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?
    };
    validate_companion_agent_kind(current.agent_kind, update.agent_kind)?;

    {
        let mut db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::update_session_settings(
            &mut db,
            session_id,
            update.agent_kind,
            &update.permission_config.to_string(),
            &update.plan_mode,
            update.provider_id.as_deref(),
            update.model.as_deref(),
            update.reasoning_effort.as_deref(),
        )
        .map_err(|error| error.to_string())?;
    }

    let sidecar_running = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.contains_key(session_id)
    };
    if sidecar_running {
        let cwd = resolve_session_cwd(app_state, session_id)?;
        let reasoning_effort = {
            let db = app_state.db.lock().map_err(|error| error.to_string())?;
            operations::get_session(&db, session_id)
                .map_err(|error| error.to_string())?
                .and_then(|session| session.reasoning_effort)
        };
        if let Err(error) =
            ensure_agent_session_for_companion(daemon, session_id, cwd, reasoning_effort).await
        {
            log::warn!(
                target: "companion",
                "Failed to refresh runtime after mobile settings update session_id={}: {}",
                session_id,
                error
            );
        }
    }

    let db = app_state.db.lock().map_err(|error| error.to_string())?;
    operations::get_session(&db, session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "会话不存在".to_string())
}

pub async fn interrupt_companion_session(
    daemon: &DaemonState,
    session_id: &str,
) -> Result<(), String> {
    let app_state = &daemon.app;
    let agent_state = &daemon.agent;
    let companion_state = &daemon.companion;
    interrupt_agent_session_for_companion(app_state, agent_state, session_id).await?;
    let _ = companion_state.finish_turn(session_id);
    Ok(())
}

pub async fn respond_companion_permission(
    daemon: &DaemonState,
    session_id: &str,
    request_id: &str,
    response: serde_json::Value,
) -> Result<(), String> {
    let app_state = &daemon.app;
    let agent_state = &daemon.agent;
    crate::agent::commands::reject_read_only_session(app_state, session_id)?;

    let cmd = OpenCodeRuntime::respond_to_permission_command(request_id, session_id, response);
    send_command_to_session(agent_state, session_id, cmd).await
}

pub async fn send_companion_tool_response(
    daemon: &DaemonState,
    session_id: &str,
    tool_use_id: &str,
    response: serde_json::Value,
) -> Result<(), String> {
    let app_state = &daemon.app;
    let agent_state = &daemon.agent;
    crate::agent::commands::reject_read_only_session(app_state, session_id)?;

    let cmd = serde_json::json!({
        "type": "tool_response",
        "toolUseId": tool_use_id,
        "response": response,
    });
    send_command_to_session(agent_state, session_id, cmd).await
}

#[cfg(test)]
mod tests {
    use super::{
        decide_active_sidecar_send, validate_companion_agent_kind, ActiveSidecarSendDecision,
    };
    use crate::config::types::AgentKind;

    #[test]
    fn concurrent_client_send_queues_when_turn_is_active() {
        assert_eq!(
            decide_active_sidecar_send(None, true),
            ActiveSidecarSendDecision::Enqueue
        );
    }

    #[test]
    fn idle_sidecar_starts_a_new_turn() {
        assert_eq!(
            decide_active_sidecar_send(None, false),
            ActiveSidecarSendDecision::StartTurn
        );
    }

    #[test]
    fn steer_delivery_bypasses_queue() {
        assert_eq!(
            decide_active_sidecar_send(Some("steer"), true),
            ActiveSidecarSendDecision::Steer
        );
    }

    #[test]
    fn rejects_companion_agent_kind_changes() {
        assert_eq!(
            validate_companion_agent_kind(AgentKind::ClaudeCode, AgentKind::Codex),
            Err("会话创建后不能更换智能体种类".to_string())
        );
    }

    #[test]
    fn dual_client_send_keeps_one_active_turn_then_drains_queue() {
        use super::ActiveSidecarSendDecision;
        use crate::companion::CompanionState;

        let state = CompanionState::new();
        let session_id = "session-1";

        assert_eq!(
            decide_active_sidecar_send(None, state.is_turn_active(session_id)),
            ActiveSidecarSendDecision::StartTurn
        );
        state.mark_turn_active(session_id);

        assert_eq!(
            decide_active_sidecar_send(None, state.is_turn_active(session_id)),
            ActiveSidecarSendDecision::Enqueue
        );
        state.enqueue_message(session_id, "cli message".to_string(), None);

        let queued = state.finish_turn(session_id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].prompt, "cli message");
        assert!(!state.is_turn_active(session_id));

        assert_eq!(
            decide_active_sidecar_send(None, state.is_turn_active(session_id)),
            ActiveSidecarSendDecision::StartTurn
        );
    }

    #[test]
    fn allows_companion_settings_when_agent_kind_is_unchanged() {
        assert!(validate_companion_agent_kind(AgentKind::Opencode, AgentKind::Opencode).is_ok());
    }
}
