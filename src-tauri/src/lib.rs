mod db;
mod config;
mod commands;
mod agent;
mod agent_runtime;
mod mcp;
mod skills;

use log::{info, warn};
use tauri::menu::MenuBuilder;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Window, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use std::sync::Mutex;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_ID: &str = "tray_open";
const TRAY_QUIT_ID: &str = "tray_quit";

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    /// MCP connection status from startup probe: server name → connected?
    pub mcp_status: Mutex<std::collections::HashMap<String, bool>>,
    /// Cached MCP server instructions from startup probe: server name → instructions text.
    /// Shared via Arc so the background probe task can populate it.
    pub mcp_instructions: std::sync::Arc<Mutex<std::collections::HashMap<String, String>>>,
}

fn should_hide_to_tray(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

fn show_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_window_to_tray<R: tauri::Runtime>(window: &Window<R>) {
    let _ = window.hide();
}

fn handle_tray_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event_id: &str) {
    match event_id {
        TRAY_OPEN_ID => show_main_window(app),
        TRAY_QUIT_ID => app.exit(0),
        _ => {}
    }
}

fn handle_global_window_event<R: tauri::Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if should_hide_to_tray(window.label()) {
            api.prevent_close();
            hide_window_to_tray(window);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(handle_global_window_event)
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("codemux".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .level_for("codemux_lib", log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepSome(10))
                .max_file_size(1_048_576)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                show_main_window(app);
            }
        })
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            info!(target: "app", "Application starting; log directory={}", log_dir.display());

            let conn = db::initialize(&app.handle()).expect("Failed to initialize database");
            let config = config::load_config(&app.handle());
            info!(
                target: "app",
                "Runtime initialized; providers={} theme={:?}",
                config.providers.len(),
                config.theme
            );

            let mcp_instructions_cache = std::sync::Arc::new(Mutex::new(std::collections::HashMap::<String, String>::new()));
            let mcp_instructions_for_probe = mcp_instructions_cache.clone();

            // Background probe: check MCP server connectivity at startup
            // and cache instructions for later use by agent sessions
            let probe_conn = db::initialize(&app.handle()).expect("Failed to init probe DB");
            tauri::async_runtime::spawn(async move {
                let servers = mcp::db::get_enabled_mcp_servers(&probe_conn).unwrap_or_default();
                if servers.is_empty() {
                    info!(target: "mcp_probe", "Startup probe skipped: no enabled MCP servers");
                    return;
                }
                info!(target: "mcp_probe", "Startup probe beginning for {} MCP server(s)", servers.len());
                let results = commands::mcp::probe_servers(&servers).await;
                let connected = results.values().filter(|r| r.connected).count();
                info!(target: "mcp_probe", "Startup probe finished: {}/{} connected", connected, results.len());
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
                    info!(target: "mcp_probe", "Cached MCP instructions for {} server(s)", cache.len());
                } else {
                    warn!(target: "mcp_probe", "No MCP server instructions were cached during startup probe");
                }
            });

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
                mcp_status: Mutex::new(std::collections::HashMap::new()),
                mcp_instructions: mcp_instructions_cache,
            });
            app.manage(agent::commands::AgentState::default());

            let tray_menu = MenuBuilder::new(app)
                .text(TRAY_OPEN_ID, "打开 codeMUX")
                .separator()
                .text(TRAY_QUIT_ID, "退出")
                .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .tooltip("codeMUX")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| handle_tray_menu_event(app, event.id().as_ref()));

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider::get_config,
            commands::provider::update_provider,
            commands::provider::delete_provider,
            commands::provider::set_active_provider,
            commands::provider::set_default_agent_kind,
            commands::provider::update_agent_config,
            commands::provider::set_theme,
            commands::provider::fetch_provider_models,
            commands::provider::test_provider,
            commands::app::get_log_directory,
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
            commands::file::write_file,
            commands::file::delete_file,
            commands::file::open_in_explorer,
            commands::file::list_directory,
            commands::mcp::get_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::toggle_mcp_server,
            commands::mcp::probe_all_mcp_servers,
            agent::commands::ensure_agent_session,
            agent::commands::send_agent_input,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
            agent::commands::reset_agent_session,
            agent::commands::send_tool_response,
            agent::commands::delete_claude_session_files,
            agent::commands::load_claude_session_events,
            agent::commands::start_codex_proxy,
            agent::commands::stop_codex_proxy,
            agent::commands::get_codex_proxy_port,
            skills::commands::list_installed_skills,
            skills::commands::uninstall_skill,
            skills::commands::toggle_skill,
            skills::commands::get_skill_content,
            skills::commands::sync_builtin_skills,
            skills::commands::register_skill_from_disk,
            skills::commands::get_enabled_skill_names,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::should_hide_to_tray;

    #[test]
    fn hides_only_the_main_window_to_tray() {
        assert!(should_hide_to_tray("main"));
        assert!(!should_hide_to_tray("settings"));
    }
}
