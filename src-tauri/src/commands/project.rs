use tauri::State;
use crate::AppState;
use crate::db::operations;

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    path: String,
) -> Result<operations::Project, String> {
    let db = state.db.lock().unwrap();
    operations::create_project(&db, &name, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_projects(
    state: State<'_, AppState>,
) -> Result<Vec<operations::Project>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_projects(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::delete_project(&db, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::rename_project(&db, &project_id, &name).map_err(|e| e.to_string())
}
