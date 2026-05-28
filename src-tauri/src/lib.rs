mod db;
mod config;
mod commands;
mod provider;

use tauri::Manager;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let conn = db::initialize(&app.handle()).expect("Failed to initialize database");
            let config = config::load_config(&app.handle());

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider::get_config,
            commands::provider::update_provider,
            commands::provider::set_active_provider,
            commands::provider::set_theme,
            commands::provider::test_connection,
            commands::session::create_session,
            commands::session::get_all_sessions,
            commands::session::delete_session,
            commands::session::update_session_title,
            commands::session::get_messages,
            commands::chat::send_message,
            commands::chat::send_message_stream,
            commands::file::read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
