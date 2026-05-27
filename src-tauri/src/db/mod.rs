pub mod schema;
pub mod operations;

use rusqlite::{Connection, Result};
use std::path::PathBuf;
use tauri::AppHandle;

pub fn get_database_path(app: &AppHandle) -> Result<PathBuf> {
    let app_dir = app.path().app_data_dir().map_err(|e| rusqlite::Error::InvalidPath(e.into()))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| rusqlite::Error::InvalidPath(e.into()))?;
    Ok(app_dir.join("codemux.db"))
}

pub fn initialize(app: &AppHandle) -> Result<Connection> {
    let db_path = get_database_path(app)?;
    let conn = Connection::open(db_path)?;
    schema::initialize_database(&conn)?;
    Ok(conn)
}
