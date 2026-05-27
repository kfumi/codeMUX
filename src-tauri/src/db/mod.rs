pub mod schema;
pub mod operations;

use rusqlite::{Connection, Result};
use std::path::PathBuf;
use tauri::AppHandle;

pub fn get_database_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    app_dir.join("codemux.db")
}

pub fn initialize(app: &AppHandle) -> Result<Connection> {
    let db_path = get_database_path(app);
    let conn = Connection::open(db_path)?;
    schema::initialize_database(&conn)?;
    Ok(conn)
}
