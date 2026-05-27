use tauri::State;
use crate::AppState;
use crate::db::operations;

#[tauri::command]
pub fn create_session(state: State<'_, AppState>, title: String) -> Result<operations::Session, String> {
    let db = state.db.lock().unwrap();
    operations::create_session(&db, &title).map_err(|e| e.to_string())
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
