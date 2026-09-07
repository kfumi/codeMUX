use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::agent::commands::{
    ensure_agent_session_for_companion, interrupt_agent_session_for_companion,
    send_command_to_session, AgentState,
};
use crate::agent_runtime::opencode::OpenCodeRuntime;
use crate::companion::CompanionState;
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;

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
    app: &AppHandle,
    session_id: &str,
    prompt: &str,
    input_payload: Option<serde_json::Value>,
    delivery: Option<&str>,
    request_id: Option<&str>,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    let companion_state = app.state::<CompanionState>();

    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let sidecar_running = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.contains_key(session_id)
    };

    if sidecar_running {
        match decide_active_sidecar_send(delivery, companion_state.is_turn_active(session_id)) {
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
            return send_command_to_session(&agent_state, session_id, cmd).await;
            }
            ActiveSidecarSendDecision::Enqueue => {
                companion_state.enqueue_message(session_id, prompt.to_string(), input_payload);
                return Ok(());
            }
            ActiveSidecarSendDecision::StartTurn => {
        companion_state.mark_turn_active(session_id);
        let mut cmd = OpenCodeRuntime::send_input_command(session_id, prompt.to_string(), None);
        if let Some(input_payload) = input_payload {
            cmd["inputPayload"] = input_payload;
        }
        let result = send_command_to_session(&agent_state, session_id, cmd).await;
        if result.is_err() {
            let _ = companion_state.finish_turn(session_id);
        }
        return result;
            }
        }
    }

    companion_state.mark_turn_active(session_id);
    let cwd = resolve_session_cwd(app_state.inner(), session_id)?;
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    let reasoning_effort = {
        let db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .and_then(|session| session.reasoning_effort)
    };

    let result = crate::agent::commands::start_agent_session(
        app.clone(),
        app_state,
        agent_state,
        session_id.to_string(),
        prompt.to_string(),
        cwd,
        channel,
        reasoning_effort,
        input_payload,
        None,
        Some(false),
    )
    .await;
    if result.is_err() {
        let _ = companion_state.finish_turn(session_id);
    }
    result
}

fn validate_companion_agent_kind(current: AgentKind, requested: AgentKind) -> Result<(), String> {
    if current != requested {
        return Err("会话创建后不能更换智能体种类".to_string());
    }
    Ok(())
}

pub async fn update_companion_settings(
    app: &AppHandle,
    session_id: &str,
    update: CompanionSettingsUpdate,
) -> Result<operations::Session, String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    let companion_state = app.state::<CompanionState>();

    crate::agent::commands::reject_read_only_session(app_state.inner(), session_id)?;
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
    if let Err(error) = validate_companion_agent_kind(current.agent_kind, update.agent_kind) {
        return Err(error);
    }

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
        let cwd = resolve_session_cwd(app_state.inner(), session_id)?;
        let reasoning_effort = {
            let db = app_state.db.lock().map_err(|error| error.to_string())?;
            operations::get_session(&db, session_id)
                .map_err(|error| error.to_string())?
                .and_then(|session| session.reasoning_effort)
        };
        if let Err(error) = ensure_agent_session_for_companion(
            app,
            app_state.inner(),
            agent_state.inner(),
            session_id,
            cwd,
            reasoning_effort,
        )
        .await
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

pub async fn interrupt_companion_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    let companion_state = app.state::<CompanionState>();
    interrupt_agent_session_for_companion(app_state.inner(), agent_state.inner(), session_id)
        .await?;
    let _ = companion_state.finish_turn(session_id);
    Ok(())
}

pub async fn respond_companion_permission(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    response: serde_json::Value,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let cmd = OpenCodeRuntime::respond_to_permission_command(request_id, session_id, response);
    send_command_to_session(&agent_state, session_id, cmd).await
}

pub async fn send_companion_tool_response(
    app: &AppHandle,
    session_id: &str,
    tool_use_id: &str,
    response: serde_json::Value,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let cmd = serde_json::json!({
        "type": "tool_response",
        "toolUseId": tool_use_id,
        "response": response,
    });
    send_command_to_session(&agent_state, session_id, cmd).await
}

pub fn resolve_static_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let release_dir = manifest_dir.join("../dist-mobile");
    if release_dir.exists() {
        return release_dir;
    }
    manifest_dir.join("../src-mobile/dist")
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
