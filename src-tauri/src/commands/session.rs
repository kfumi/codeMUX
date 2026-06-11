use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;
use log::{debug, info};
use std::str::FromStr;
use tauri::State;

#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    title: String,
    agent_kind: Option<String>,
    mode: Option<String>,
    project_id: Option<String>,
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
        Some(pid) => operations::create_session_for_project(&db, &title, agent_kind, mode_str, pid)
            .map_err(|e| e.to_string()),
        None => operations::create_session_with_mode(&db, &title, agent_kind, mode_str)
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn get_all_sessions(state: State<'_, AppState>) -> Result<Vec<operations::Session>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_sessions(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    info!(target: "session", "Deleting session session_id={}", session_id);
    let db = state.db.lock().unwrap();
    operations::delete_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_title(state: State<'_, AppState>, session_id: String, title: String) -> Result<(), String> {
    debug!(target: "session", "Updating session title session_id={} title={}", session_id, title);
    let db = state.db.lock().unwrap();
    operations::update_session_title(&db, &session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_provider(state: State<'_, AppState>, session_id: String, provider_id: String, model: String) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session provider session_id={} provider_id={} model={}",
        session_id,
        provider_id,
        model
    );
    let db = state.db.lock().unwrap();
    operations::update_session_provider(&db, &session_id, &provider_id, &model).map_err(|e| e.to_string())
}
