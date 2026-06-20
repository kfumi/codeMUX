use std::fs;

use log::info;
use serde::Serialize;
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

/// Returns the app data directory path (where config.json lives).
#[tauri::command]
pub fn get_app_data_directory(app: AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;

    Ok(data_dir.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
pub struct LogFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
}

/// List log files in the log directory.
#[tauri::command]
pub fn get_log_files(app: AppHandle) -> Result<Vec<LogFileInfo>, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve log directory: {}", error))?;

    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files: Vec<LogFileInfo> = Vec::new();
    let entries = fs::read_dir(&log_dir)
        .map_err(|error| format!("Failed to read log directory: {}", error))?;

    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let size = metadata.len();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                let datetime: chrono::DateTime<chrono::Local> = t.into();
                Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
            })
            .unwrap_or_default();

        files.push(LogFileInfo { name, path, size, modified });
    }

    // Sort by modified time, newest first
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(files)
}

/// Read the content of a log file by path.
#[tauri::command]
pub fn read_log_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| format!("Failed to read log file: {}", error))
}
