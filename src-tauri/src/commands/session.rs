use tauri::State;
use crate::AppState;
use crate::db::operations;

#[tauri::command]
pub fn save_agent_events(
    state: State<'_, AppState>,
    session_id: String,
    events_json: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    // Delete existing agent events for this session
    db.execute(
        "DELETE FROM messages WHERE session_id = ?1 AND role = 'agent'",
        rusqlite::params![session_id],
    ).map_err(|e| e.to_string())?;
    // Save new events as a single JSON blob
    operations::create_message(&db, &session_id, "agent", &events_json)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_agent_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    let messages = operations::get_messages_by_role(&db, &session_id, "agent")
        .map_err(|e| e.to_string())?;
    // Return the events JSON (latest one)
    Ok(messages.last().map(|m| m.content.clone()).unwrap_or_default())
}

#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    title: String,
    mode: Option<String>,
    project_id: Option<String>,
) -> Result<operations::Session, String> {
    let db = state.db.lock().unwrap();
    let mode_str = mode.as_deref().unwrap_or("chat");
    match project_id.as_deref() {
        Some(pid) => operations::create_session_for_project(&db, &title, mode_str, pid)
            .map_err(|e| e.to_string()),
        None => operations::create_session_with_mode(&db, &title, mode_str)
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
    let db = state.db.lock().unwrap();
    operations::delete_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_title(state: State<'_, AppState>, session_id: String, title: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::update_session_title(&db, &session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_messages(state: State<'_, AppState>, session_id: String) -> Result<Vec<operations::Message>, String> {
    let db = state.db.lock().unwrap();
    operations::get_messages_by_session(&db, &session_id).map_err(|e| e.to_string())
}
