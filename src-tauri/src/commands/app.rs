use std::fs;

use log::info;
use tauri::AppHandle;
use tauri::Manager;

#[tauri::command]
pub fn get_log_directory(app: AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve log directory: {}", error))?;

    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create log directory: {}", error))?;

    info!(target: "app", "Resolved log directory at {}", log_dir.display());

    Ok(log_dir.to_string_lossy().to_string())
}
