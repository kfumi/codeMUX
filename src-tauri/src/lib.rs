mod agent;
mod agent_runtime;
mod commands;
mod config;
mod db;
mod mcp;
mod skills;

use log::info;
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Window, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_ID: &str = "tray_open";
const TRAY_QUIT_ID: &str = "tray_quit";

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    pub app_data_dir: std::path::PathBuf,
}

fn should_hide_to_tray(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

fn should_activate_main_window_for_second_instance(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

fn show_window<R: tauri::Runtime, M: Manager<R>>(manager: &M, window_label: &str) {
    if let Some(window) = manager.get_webview_window(window_label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    show_window(manager, MAIN_WINDOW_LABEL);
}

fn activate_main_window_for_second_instance<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if should_activate_main_window_for_second_instance(MAIN_WINDOW_LABEL) {
        show_main_window(manager);
    }
}

fn hide_window_to_tray<R: tauri::Runtime>(window: &Window<R>) {
    let _ = window.hide();
}

#[tauri::command]
fn show_main_window_command(app: tauri::AppHandle) {
    show_main_window(&app);
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
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            activate_main_window_for_second_instance(app);
        }));
    }

    builder
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
                app_data_dir: app.path().app_data_dir()?,
            });
            app.manage(agent::commands::AgentState::default());
            app.manage(commands::terminal::TerminalState::default());

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
            commands::provider::set_compact_ai_output,
            commands::provider::set_notification_settings,
            commands::provider::fetch_provider_models,
            commands::provider::test_provider,
            commands::app::get_log_directory,
            commands::app::get_app_data_directory,
            commands::app::check_development_environment,
            commands::app::get_log_files,
            commands::app::read_log_file,
            show_main_window_command,
            commands::session::create_session,
            commands::session::get_all_sessions,
            commands::session::get_archived_sessions,
            commands::session::delete_session,
            commands::session::archive_session,
            commands::session::unarchive_session,
            commands::session::set_session_pinned,
            commands::session::update_session_title,
            commands::session::touch_session,
            commands::session::update_session_provider,
            commands::session::update_session_permissions,
            commands::project::create_project,
            commands::project::get_all_projects,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::file::read_file,
            commands::file::write_file,
            commands::file::delete_file,
            commands::file::open_in_explorer,
            commands::file::list_directory,
            commands::git::get_git_changed_files,
            commands::git::get_git_changed_files_since_head,
            commands::git::get_git_repository_state,
            commands::git::create_git_branch,
            commands::git::checkout_git_branch,
            commands::git::get_git_status_change_detail,
            commands::git::get_git_status_changes,
            commands::git::stage_git_status_changes,
            commands::git::unstage_git_status_changes,
            commands::git::revert_git_status_changes,
            commands::git::commit_git_changes,
            commands::git::push_git_branch,
            commands::git::generate_git_commit_message,
            commands::terminal::start_terminal_session,
            commands::terminal::write_terminal_session,
            commands::terminal::resize_terminal_session,
            commands::terminal::close_terminal_session,
            commands::mcp::get_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::toggle_mcp_app,
            commands::mcp::import_mcp_from_apps,
            commands::mcp::probe_mcp_server,
            commands::mcp::probe_all_mcp_servers,
            agent::commands::ensure_agent_session,
            agent::commands::send_agent_input,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
            agent::commands::reset_agent_session,
            agent::commands::send_tool_response,
            agent::commands::delete_claude_session_files,
            agent::commands::delete_codex_session_files,
            agent::commands::load_claude_session_events,
            agent::commands::load_codex_session_events,
            agent::commands::rewind_agent_session,
            agent::commands::get_agent_session_info,
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
    use super::{should_activate_main_window_for_second_instance, should_hide_to_tray};

    #[test]
    fn hides_only_the_main_window_to_tray() {
        assert!(should_hide_to_tray("main"));
        assert!(!should_hide_to_tray("settings"));
    }

    #[test]
    fn activates_only_the_main_window_for_second_instance() {
        assert!(should_activate_main_window_for_second_instance("main"));
        assert!(!should_activate_main_window_for_second_instance("settings"));
    }
}
