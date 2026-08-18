use crate::agent::commands::{
    delete_opencode_native_session, home_dir, send_permission_update_to_session, AgentState,
};
use crate::agent::native_cleanup::{
    cleanup_claude_native_session, cleanup_codex_app_interactive_events,
    cleanup_codex_native_session,
};
use crate::config::types::AgentKind;
use crate::db::operations::{self, NativeSessionRef};
use crate::AppState;
use log::{info, warn};
use std::str::FromStr;
use tauri::{AppHandle, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    state: State<'_, AppState>,
    title: String,
    agent_kind: Option<String>,
    mode: Option<String>,
    project_id: Option<String>,
    permission_config: Option<String>,
    plan_mode: Option<String>,
    model: Option<String>,
) -> Result<operations::Session, String> {
    let agent_kind = AgentKind::from_str(agent_kind.as_deref().unwrap_or("claude_code"))?;
    info!(
        target: "session",
        "Creating session title={} agent_kind={} mode={} project_id={}",
        title,
        agent_kind.as_str(),
        mode.as_deref().unwrap_or("chat"),
        project_id.as_deref().unwrap_or("none")
    );
    let db = state.db.lock().unwrap();
    let mode_str = mode.as_deref().unwrap_or("chat");
    match project_id.as_deref() {
        Some(pid) => operations::create_session_for_project_with_permissions(
            &db,
            &title,
            agent_kind,
            mode_str,
            pid,
            permission_config.as_deref(),
            plan_mode.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string()),
        None => operations::create_session_with_mode_and_permissions(
            &db,
            &title,
            agent_kind,
            mode_str,
            permission_config.as_deref(),
            plan_mode.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn get_all_sessions(state: State<'_, AppState>) -> Result<Vec<operations::Session>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_sessions(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_archived_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<operations::Session>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_archived_sessions(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    info!(target: "session", "Deleting session session_id={}", session_id);
    let (skip_native_cleanup, native_sessions) = {
        let db = state.db.lock().unwrap();
        let session =
            operations::get_session(&db, &session_id).map_err(|error| error.to_string())?;
        let skip = session
            .as_ref()
            .is_some_and(|session| session.origin == "imported" || session.is_read_only);
        let natives = if skip {
            Vec::new()
        } else {
            operations::list_native_sessions_for_cleanup(&db, &session_id)
                .map_err(|error| error.to_string())?
        };
        (skip, natives)
    };

    if !skip_native_cleanup {
        cleanup_native_sessions_best_effort(
            &app,
            state.inner(),
            agent_state.inner(),
            &session_id,
            &native_sessions,
            true,
        )
        .await;
    }

    let db = state.db.lock().unwrap();
    operations::delete_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    info!(target: "session", "Archiving session session_id={}", session_id);
    let db = state.db.lock().unwrap();
    operations::archive_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unarchive_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    info!(target: "session", "Unarchiving session session_id={}", session_id);
    let db = state.db.lock().unwrap();
    operations::unarchive_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_session_pinned(
    state: State<'_, AppState>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    info!(target: "session", "Setting session pinned session_id={} pinned={}", session_id, pinned);
    let db = state.db.lock().unwrap();
    operations::set_session_pinned(&db, &session_id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_session_read_only(
    state: State<'_, AppState>,
    session_id: String,
    read_only: bool,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let session = operations::get_session(&db, &session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Session not found: {}", session_id))?;
    if session.origin != "imported" {
        return Err("Only imported sessions can change read-only state".to_string());
    }
    operations::set_session_read_only(&db, &session_id, read_only).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_title(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::update_session_title(&db, &session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn touch_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::touch_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_provider(
    state: State<'_, AppState>,
    session_id: String,
    provider_id: Option<String>,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session provider session_id={} provider_id={:?} model={} reasoning_effort={}",
        session_id,
        provider_id,
        model,
        reasoning_effort.as_deref().unwrap_or("unchanged")
    );
    let db = state.db.lock().unwrap();
    operations::update_session_provider(
        &db,
        &session_id,
        provider_id.as_deref(),
        &model,
        reasoning_effort.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_reasoning_effort(
    state: State<'_, AppState>,
    session_id: String,
    reasoning_effort: String,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session reasoning effort session_id={} reasoning_effort={}",
        session_id,
        reasoning_effort
    );
    let db = state.db.lock().unwrap();
    operations::update_session_reasoning_effort(&db, &session_id, &reasoning_effort)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_session_permissions(
    state: State<'_, AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session permissions session_id={} has_permission_config={} plan_mode={}",
        session_id,
        permission_config.as_ref().map(|value| !value.is_empty()).unwrap_or(false),
        plan_mode.as_deref().unwrap_or("unchanged")
    );
    if state
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT is_read_only FROM sessions WHERE id = ?1",
            [&session_id],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        != 0
    {
        return Err("会话为只读，原生会话无法恢复".to_string());
    }
    {
        let db = state.db.lock().unwrap();
        operations::update_session_permissions(
            &db,
            &session_id,
            permission_config.as_deref(),
            plan_mode.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    }

    if let Err(error) = send_permission_update_to_session(&state, &agent_state, &session_id).await {
        warn!(
            target: "session",
            "Runtime permission update skipped after DB save session_id={} error={}",
            session_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub fn save_session_message_attachments(
    state: State<'_, AppState>,
    session_id: String,
    user_index: i64,
    attachments: Vec<serde_json::Value>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::save_session_message_attachments(&db, &session_id, user_index, &attachments)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_session_message_attachments(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<std::collections::HashMap<i64, Vec<serde_json::Value>>, String> {
    let db = state.db.lock().unwrap();
    operations::get_session_message_attachments(&db, &session_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn switch_session_agent_kind(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    to_kind: String,
    provider_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<operations::Session, String> {
    use crate::agent::switch_briefing::{
        build_runtime_switch_system_event, build_switch_briefing, default_permission_config_json,
        is_switchable_agent_kind,
    };

    let to_kind = AgentKind::from_str(&to_kind)?;
    if !is_switchable_agent_kind(to_kind) {
        return Err("该智能体种类当前不可切换".to_string());
    }

    let session = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?
    };
    if session.is_read_only || session.origin == "imported" {
        return Err("只读或导入快照会话不能切换智能体".to_string());
    }
    let from_kind = session.agent_kind;
    if from_kind == to_kind {
        return Ok(session);
    }
    if !is_switchable_agent_kind(from_kind) {
        return Err("当前智能体种类不支持切换".to_string());
    }

    let events =
        crate::agent::history_import::load_session_events(state.clone(), session_id.clone())
            .await
            .unwrap_or_default();
    let briefing = build_switch_briefing(&events, from_kind, to_kind);
    let switch_event =
        build_runtime_switch_system_event(&session_id, from_kind, to_kind, events.len(), &briefing);
    let mut snapshot_events = events;
    snapshot_events.push(switch_event);

    let incoming_selection = {
        let db = state.db.lock().unwrap();
        operations::get_session_kind_model_selection(&db, &session_id, to_kind)
            .map_err(|error| error.to_string())?
    };
    let next_provider_id = incoming_selection
        .as_ref()
        .and_then(|selection| selection.provider_id.clone())
        .or(provider_id);
    let next_model = incoming_selection
        .as_ref()
        .and_then(|selection| selection.model.clone())
        .or(model);
    let next_effort = incoming_selection
        .as_ref()
        .and_then(|selection| selection.reasoning_effort.clone())
        .or(reasoning_effort);

    let (updated, abandoned) = {
        let mut db = state.db.lock().unwrap();
        let abandoned =
            operations::current_native_sessions_for_kinds(&db, &session_id, &[from_kind, to_kind])
                .map_err(|error| error.to_string())?;
        operations::upsert_session_kind_model_selection(
            &db,
            &operations::SessionKindModelSelection {
                session_id: session_id.clone(),
                agent_kind: from_kind,
                provider_id: session.provider_id.clone(),
                model: session.model.clone(),
                reasoning_effort: session.reasoning_effort.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        operations::update_session_agent_kind(
            &db,
            &session_id,
            to_kind,
            default_permission_config_json(to_kind),
            "off",
            next_provider_id.as_deref(),
            next_model.as_deref(),
            next_effort.as_deref(),
        )
        .map_err(|error| error.to_string())?;
        operations::delete_agent_session_mapping(&db, &session_id, from_kind)
            .map_err(|error| error.to_string())?;
        operations::delete_agent_session_mapping(&db, &session_id, to_kind)
            .map_err(|error| error.to_string())?;
        operations::replace_session_snapshot(&mut db, &session_id, &snapshot_events)
            .map_err(|error| error.to_string())?;
        operations::insert_session_runtime_switch(
            &db,
            &session_id,
            from_kind,
            to_kind,
            snapshot_events.len() as i64 - 1,
            None,
            Some(&briefing),
        )
        .map_err(|error| error.to_string())?;
        operations::set_pending_switch_briefing(&db, &session_id, Some(&briefing))
            .map_err(|error| error.to_string())?;
        let updated = operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        (updated, abandoned)
    };

    cleanup_native_sessions_best_effort(
        &app,
        state.inner(),
        agent_state.inner(),
        &session_id,
        &abandoned,
        false,
    )
    .await;

    Ok(updated)
}

pub(crate) async fn cleanup_native_sessions_best_effort(
    app: &AppHandle,
    state: &AppState,
    agent_state: &AgentState,
    app_session_id: &str,
    sessions: &[NativeSessionRef],
    include_codex_interactive: bool,
) {
    let home = home_dir().ok();
    for session in sessions {
        match session.agent_kind {
            AgentKind::ClaudeCode => {
                if let Some(home) = home.as_ref() {
                    if let Err(error) =
                        cleanup_claude_native_session(home, &session.agent_session_id)
                    {
                        warn!(
                            target: "session",
                            "Failed to clean Claude native session app_session_id={} agent_session_id={}: {}",
                            app_session_id,
                            session.agent_session_id,
                            error
                        );
                    }
                }
            }
            AgentKind::Codex => {
                if let Some(home) = home.as_ref() {
                    if let Err(error) =
                        cleanup_codex_native_session(home, &session.agent_session_id)
                    {
                        warn!(
                            target: "session",
                            "Failed to clean Codex native session app_session_id={} agent_session_id={}: {}",
                            app_session_id,
                            session.agent_session_id,
                            error
                        );
                    }
                }
            }
            AgentKind::Opencode => {
                if let Err(error) = delete_opencode_native_session(
                    app,
                    state,
                    agent_state,
                    app_session_id,
                    &session.agent_session_id,
                )
                .await
                {
                    warn!(
                        target: "session",
                        "Failed to clean OpenCode native session app_session_id={} agent_session_id={}: {}",
                        app_session_id,
                        session.agent_session_id,
                        error
                    );
                }
            }
            AgentKind::GeminiCli => {}
        }
    }

    if include_codex_interactive {
        if let Some(home) = home.as_ref() {
            if let Err(error) = cleanup_codex_app_interactive_events(home, app_session_id) {
                warn!(
                    target: "session",
                    "Failed to clean Codex interactive events app_session_id={}: {}",
                    app_session_id,
                    error
                );
            }
        }
    }
}
