use std::sync::Arc;

use log::warn;

use crate::agent::session_lifecycle::AgentState;
use crate::companion::actions::send_companion_message_owned;
use crate::companion::state::CompanionBroadcastEvent;
use crate::companion::{stream_coalescer, CompanionState};
use crate::paths::PathRoots;
use crate::AppState;

/// Broadcast sidecar domain events (already persisted and sequence-stamped by
/// the timeline owner) to companion clients and drive turn lifecycle. This hook
/// must not persist: the sidecar event loop is the single persistence owner,
/// and persisting here again wrote every event twice.
///
/// 广播前经 `DeltaCoalescer` 把同键连续 delta 合帧(见 stream_coalescer):
/// 副作用循环保持逐事件交错不变,仅 WS 发射侧合并。
pub fn handle_sidecar_event_for_companion(
    app: &Arc<AppState>,
    agent_state: &Arc<AgentState>,
    companion_state: &Arc<CompanionState>,
    roots: &PathRoots,
    events: Vec<serde_json::Value>,
) {
    let companion_enabled = companion_state.inner.is_enabled();
    let mut coalescer = companion_enabled.then(stream_coalescer::DeltaCoalescer::new);

    for event in events {
        let session_id = event
            .get("session_id")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string();
        track_subagent_flow_state(companion_state, &session_id, &event);
        // 工作任务状态回写（票 02）：turn_finished/error/user_input_requested 等
        // 会话事件驱动任务状态机，状态实际变化才广播 work-tasks-changed。
        if !session_id.is_empty() {
            crate::work_tasks::handle_session_event(companion_state, &session_id, &event, app);
        }
        // 顺序契约（2026-10 排队消息展示异常的根因）：终态事件必须**先广播**，再翻转
        // `is_turn_active`。WS 订阅者在每个事件帧发出后按 `is_turn_active` 派生
        // state 帧（见 server.rs `handle_socket`），因此若翻转先于广播，state 帧
        // 会插在终态事件**之前**——客户端会按「服务端已空闲」先收尾并立刻派发排队
        // 消息，随后迟到的终态事件被 append 到新回合用户消息之后：旧回合被判
        // interrupted（footer 消失）、折叠配对也拿不到 result 下标（「已处理」消失）。
        // 所以这里先广播，终态收尾（finish_turn + 队列派发）放进帧进 WS 队列之后。
        let event_type = event
            .get("type")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(coalescer) = coalescer.as_mut() {
            for frame in coalescer.push(event) {
                broadcast_frame(companion_state, frame);
            }
        }
        maybe_finish_turn_and_drain_queue(
            app,
            agent_state,
            companion_state,
            roots,
            &session_id,
            &event_type,
        );
    }

    if let Some(coalescer) = coalescer.as_mut() {
        for frame in coalescer.flush() {
            broadcast_frame(companion_state, frame);
        }
    }
}

/// 从帧自身提取 session_id(合并 delta 保留首条的 session_id)后广播。
fn broadcast_frame(companion_state: &CompanionState, event: serde_json::Value) {
    let session_id = event
        .get("session_id")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    broadcast_event(companion_state, &session_id, event);
}

/// Maintain the async-flow busy state from broadcast events: subagent upserts
/// drive the running-children/continuation bookkeeping; a new parent turn or a
/// finished one clears the continuation wait.
fn track_subagent_flow_state(
    companion_state: &CompanionState,
    session_id: &str,
    event: &serde_json::Value,
) {
    if session_id.is_empty() {
        return;
    }
    match event.get("type").and_then(|item| item.as_str()) {
        Some("subagent_upsert") => {
            if let (Some(subagent_id), Some(status)) = (
                event.get("subagent_id").and_then(|item| item.as_str()),
                event.get("status").and_then(|item| item.as_str()),
            ) {
                companion_state.apply_subagent_upsert(session_id, subagent_id, status);
            }
        }
        Some("user_message") | Some("turn_finished") | Some("error") => {
            companion_state.clear_continuation_pending(session_id);
        }
        _ => {}
    }
}

fn maybe_finish_turn_and_drain_queue(
    app: &Arc<AppState>,
    agent_state: &Arc<AgentState>,
    companion_state: &Arc<CompanionState>,
    roots: &PathRoots,
    session_id: &str,
    event_type: &str,
) {
    if session_id.is_empty() {
        return;
    }
    if event_type == "user_message" {
        companion_state.mark_turn_active(session_id);
    }
    if event_type != "turn_finished" && event_type != "error" {
        return;
    }
    finish_turn_and_drain_queue(app, agent_state, companion_state, roots, session_id);
}

/// 运行时在回合结束前退出(工单 05):事件流关掉、而这一回合还挂着时,终态事件永远不会
/// 再来 —— 按终态对账,否则回合真值、电脑控制活动、提示条与全局 Esc 会一起挂着。
///
/// 只在**回合确实还挂着**时才收口:正常结束的回合(终态事件先到)已经收过尾,重复收口
/// 会重复广播 state 帧、把排队的消息当成「该派发了」再推一遍。
pub fn handle_agent_stream_closed_for_companion(
    app: &Arc<AppState>,
    agent_state: &Arc<AgentState>,
    companion_state: &Arc<CompanionState>,
    roots: &PathRoots,
    session_id: &str,
) {
    if session_id.is_empty() || !companion_state.is_turn_active(session_id) {
        return;
    }
    warn!(
        target: "companion",
        "Agent stream closed while the turn was still active; reconciling as terminal session_id={}",
        session_id
    );
    finish_turn_and_drain_queue(app, agent_state, companion_state, roots, session_id);
}

/// 终态收尾(工单 05 从上面抽出,两条路径共用):工作任务对账 + `finish_turn` + 派发排队消息。
///
/// 广播留在调用方:真实终态事件那条路径必须先广播事件帧再翻转真值(顺序契约见
/// `handle_sidecar_event_for_companion`),流关闭这条路径没有事件帧要排,直接翻转即可。
fn finish_turn_and_drain_queue(
    app: &Arc<AppState>,
    agent_state: &Arc<AgentState>,
    companion_state: &Arc<CompanionState>,
    roots: &PathRoots,
    session_id: &str,
) {
    {
        let conn = app.db.lock().unwrap();
        crate::scheduled_tasks::reconcile_runs_for_session(&conn, session_id);
    }

    let queued = companion_state.finish_turn(session_id);
    if queued.is_empty() {
        return;
    }

    let app = app.clone();
    let agent_state = agent_state.clone();
    let companion_state = companion_state.clone();
    let roots = roots.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        for message in queued {
            if let Err(error) = send_companion_message_owned(
                app.clone(),
                agent_state.clone(),
                companion_state.clone(),
                roots.clone(),
                &session_id,
                &message.prompt,
                message.input_payload,
                None,
                None,
            )
            .await
            {
                warn!(
                    target: "companion",
                    "Failed to dispatch queued companion message for session_id={}: {}",
                    session_id,
                    error
                );
            }
        }
    });
}

fn broadcast_event(companion_state: &CompanionState, session_id: &str, event: serde_json::Value) {
    let payload = CompanionBroadcastEvent {
        session_id: session_id.to_string(),
        event,
    };
    let _ = companion_state.inner.event_tx.send(payload);
}

/// 会话标题变更广播：原生标题刷新（agent_session_title 事件）与手动改名共用，
/// per-session WS 订阅方据此原地更新标题。
pub fn broadcast_session_title_changed(
    companion_state: &Arc<CompanionState>,
    session_id: &str,
    title: &str,
) {
    if !companion_state.inner.is_enabled() || session_id.is_empty() {
        return;
    }
    broadcast_event(
        companion_state,
        session_id,
        serde_json::json!({ "type": "session_title_changed", "title": title }),
    );
}

/// 会话时间线被整体重建(回退 / 从原生重同步 / 导入刷新)后的通知帧。
///
/// 客户端据此回退去重水位线:daemon 的 `sequence` 由 `MAX(sequence)+1` 分配
/// (见 `operations::append_timeline_events`),时间线重建后会**从 0 重新编号**,
/// 而客户端的水位线只增不减 —— 不通知的话,重建之后每一帧(包括回合终止帧)
/// 都会被客户端按旧序号空间丢掉,UI 永远停在「正在执行」。
pub fn timeline_reset_frame(session_id: &str, sequence_max: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "timeline_reset",
        "session_id": session_id,
        "sequence_max": sequence_max,
    })
}

/// 把时间线重建通知广播给该会话的 WS 订阅方。
pub fn broadcast_timeline_reset(
    companion_state: &Arc<CompanionState>,
    session_id: &str,
    sequence_max: i64,
) {
    if !companion_state.inner.is_enabled() || session_id.is_empty() {
        return;
    }
    broadcast_event(
        companion_state,
        session_id,
        timeline_reset_frame(session_id, sequence_max),
    );
}

#[cfg(test)]
mod tests {
    use super::timeline_reset_frame;

    #[test]
    fn timeline_reset_frame_carries_the_new_sequence_ceiling() {
        let frame = timeline_reset_frame("session-1", 7);
        assert_eq!(frame["type"], "timeline_reset");
        assert_eq!(frame["session_id"], "session-1");
        assert_eq!(frame["sequence_max"], 7);
    }
}
