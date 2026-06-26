pub mod operations;
pub mod schema;

use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn get_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app dir: {}", e))?;
    Ok(app_dir.join("codemux.db"))
}

pub fn initialize(app: &AppHandle) -> Result<Connection, String> {
    let db_path = get_database_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;
    schema::initialize_database(&conn)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;
    Ok(conn)
}
