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

pub async fn send_companion_message(
    app: &AppHandle,
    session_id: &str,
    prompt: &str,
    input_payload: Option<serde_json::Value>,
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
        if companion_state.is_turn_active(session_id) {
            companion_state.enqueue_message(session_id, prompt.to_string(), input_payload);
            return Ok(());
        }
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
    let abandoned_native_sessions = if current.agent_kind != update.agent_kind {
        let db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::current_native_sessions_for_kinds(
            &db,
            session_id,
            &[current.agent_kind, update.agent_kind],
        )
        .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    if current.agent_kind != update.agent_kind {
        use crate::agent::switch_briefing::{
            build_runtime_switch_system_event, build_switch_briefing, is_switchable_agent_kind,
        };

        if !is_switchable_agent_kind(current.agent_kind)
            || !is_switchable_agent_kind(update.agent_kind)
        {
            return Err("该智能体种类当前不可切换".to_string());
        }
        if current.origin == "imported" {
            return Err("导入快照会话不能切换智能体".to_string());
        }

        let events = {
            let db = app_state.db.lock().map_err(|error| error.to_string())?;
            operations::get_session_snapshot(&db, session_id)
                .map_err(|error| error.to_string())?
                .unwrap_or_default()
        };
        let briefing = build_switch_briefing(&events, current.agent_kind, update.agent_kind);
        let switch_event = build_runtime_switch_system_event(
            session_id,
            current.agent_kind,
            update.agent_kind,
            events.len(),
            &briefing,
        );
        let mut snapshot_events = events;
        snapshot_events.push(switch_event);

        let mut db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::upsert_session_kind_model_selection(
            &db,
            &operations::SessionKindModelSelection {
                session_id: session_id.to_string(),
                agent_kind: current.agent_kind,
                provider_id: current.provider_id.clone(),
                model: current.model.clone(),
                reasoning_effort: current.reasoning_effort.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
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
        operations::delete_agent_session_mapping(&db, session_id, current.agent_kind)
            .map_err(|error| error.to_string())?;
        operations::delete_agent_session_mapping(&db, session_id, update.agent_kind)
            .map_err(|error| error.to_string())?;
        operations::replace_session_snapshot(&mut db, session_id, &snapshot_events)
            .map_err(|error| error.to_string())?;
        operations::insert_session_runtime_switch(
            &db,
            session_id,
            current.agent_kind,
            update.agent_kind,
            snapshot_events.len() as i64 - 1,
            None,
            Some(&briefing),
        )
        .map_err(|error| error.to_string())?;
        operations::set_pending_switch_briefing(&db, session_id, Some(&briefing))
            .map_err(|error| error.to_string())?;
    } else {
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

    if !abandoned_native_sessions.is_empty() {
        crate::commands::session::cleanup_native_sessions_best_effort(
            app,
            app_state.inner(),
            agent_state.inner(),
            session_id,
            &abandoned_native_sessions,
            false,
        )
        .await;
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
    interrupt_agent_session_for_companion(
        app_state.inner(),
        agent_state.inner(),
        session_id,
    )
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
