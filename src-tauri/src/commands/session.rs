use crate::agent::commands::{send_permission_update_to_session, AgentState};
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;
use log::{debug, info, warn};
use std::str::FromStr;
use tauri::State;

#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    title: String,
    agent_kind: Option<String>,
    mode: Option<String>,
    project_id: Option<String>,
    permission_config: Option<String>,
    plan_mode: Option<String>,
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
        )
        .map_err(|e| e.to_string()),
        None => operations::create_session_with_mode_and_permissions(
            &db,
            &title,
            agent_kind,
            mode_str,
            permission_config.as_deref(),
            plan_mode.as_deref(),
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
pub fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    info!(target: "session", "Deleting session session_id={}", session_id);
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
pub fn update_session_title(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    debug!(target: "session", "Updating session title session_id={} title={}", session_id, title);
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
    provider_id: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session provider session_id={} provider_id={} model={} reasoning_effort={}",
        session_id,
        provider_id,
        model,
        reasoning_effort.as_deref().unwrap_or("unchanged")
    );
    let db = state.db.lock().unwrap();
    operations::update_session_provider(
        &db,
        &session_id,
        &provider_id,
        &model,
        reasoning_effort.as_deref(),
    )
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
