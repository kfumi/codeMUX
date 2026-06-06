mod db;
mod config;
mod commands;
mod agent;
mod mcp;
mod skills;

use tauri::Manager;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    /// MCP connection status from startup probe: server name → connected?
    pub mcp_status: Mutex<std::collections::HashMap<String, bool>>,
    /// Cached MCP server instructions from startup probe: server name → instructions text.
    /// Shared via Arc so the background probe task can populate it.
    pub mcp_instructions: std::sync::Arc<Mutex<std::collections::HashMap<String, String>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::initialize(&app.handle()).expect("Failed to initialize database");
            let config = config::load_config(&app.handle());

            let mcp_instructions_cache = std::sync::Arc::new(Mutex::new(std::collections::HashMap::<String, String>::new()));
            let mcp_instructions_for_probe = mcp_instructions_cache.clone();

            // Background probe: check MCP server connectivity at startup
            // and cache instructions for later use by agent sessions
            let probe_conn = db::initialize(&app.handle()).expect("Failed to init probe DB");
            tauri::async_runtime::spawn(async move {
                let servers = mcp::db::get_enabled_mcp_servers(&probe_conn).unwrap_or_default();
                if servers.is_empty() {
                    println!("[mcp-probe] Startup: no enabled MCP servers");
                    return;
                }
                println!("[mcp-probe] Startup: probing {} MCP server(s)...", servers.len());
                let results = commands::mcp::probe_servers(&servers).await;
                let connected = results.values().filter(|r| r.connected).count();
                println!("[mcp-probe] Startup: {}/{} connected", connected, results.len());
                // Cache instructions from connected servers
                let mut cache = mcp_instructions_for_probe.lock().unwrap();
                for (name, probe_result) in results {
                    if let Some(instructions) = probe_result.instructions {
                        if !instructions.is_empty() {
                            cache.insert(name, instructions);
                        }
                    }
                }
                if !cache.is_empty() {
                    println!("[mcp-probe] Startup: cached instructions for {} server(s)", cache.len());
                }
            });

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
                mcp_status: Mutex::new(std::collections::HashMap::new()),
                mcp_instructions: mcp_instructions_cache,
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
            commands::session::update_session_provider,
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
            commands::mcp::get_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::toggle_mcp_server,
            commands::mcp::probe_all_mcp_servers,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
            agent::commands::reset_agent_session,
            agent::commands::send_tool_response,
            agent::commands::delete_claude_session_files,
            skills::commands::list_installed_skills,
            skills::commands::browse_repo_skills,
            skills::commands::install_skill,
            skills::commands::uninstall_skill,
            skills::commands::toggle_skill,
            skills::commands::get_skill_content,
            skills::commands::sync_builtin_skills,
            skills::commands::register_skill_from_disk,
            skills::commands::get_skill_sources,
            skills::commands::get_enabled_skill_names,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
