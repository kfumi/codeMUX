mod db;
mod config;
mod commands;
mod agent;
mod mcp;

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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::initialize(&app.handle()).expect("Failed to initialize database");
            let config = config::load_config(&app.handle());

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
            });
            app.manage(agent::commands::AgentState::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider::get_config,
            commands::provider::update_provider,
            commands::provider::delete_provider,
            commands::provider::set_active_provider,
            commands::provider::set_theme,
            commands::provider::fetch_provider_models,
            commands::provider::test_provider,
            commands::session::create_session,
            commands::session::get_all_sessions,
            commands::session::delete_session,
            commands::session::update_session_title,
            commands::session::get_messages,
            commands::session::save_agent_events,
            commands::session::get_agent_events,
            commands::project::create_project,
            commands::project::get_all_projects,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::file::read_file,
            commands::file::open_in_explorer,
            commands::file::list_directory,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
            agent::commands::reset_agent_session,
            agent::commands::send_tool_response,
            agent::commands::delete_claude_session_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
