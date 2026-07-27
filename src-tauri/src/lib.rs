mod agent;
mod agent_runtime;
mod commands;
mod config;
mod db;
mod log_ctx;
mod mcp;
mod provider_profiles;
mod skills;

use log::info;
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::path::BaseDirectory;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, Window, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const MAIN_WINDOW_LABEL: &str = "main";
const NOTIFICATION_CLICKED_EVENT: &str = "agent-notification-clicked";
const WINDOWS_APP_USER_MODEL_ID: &str = "com.codemux.desktop";
const TRAY_OPEN_ID: &str = "tray_open";
const TRAY_QUIT_ID: &str = "tray_quit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentNotificationClickPayload {
    session_id: String,
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    pub provider_profile_operation_lock: Mutex<()>,
    pub app_data_dir: std::path::PathBuf,
}

fn should_hide_to_tray(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

fn should_activate_main_window_for_second_instance(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

fn should_register_single_instance_plugin(is_debug_build: bool) -> bool {
    !is_debug_build
}

fn show_window<R: tauri::Runtime, M: Manager<R>>(manager: &M, window_label: &str) {
    if let Some(window) = manager.get_webview_window(window_label) {
        let _ = window.unminimize();
        let _ = window.show();
        bring_window_to_front(&window);
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
fn bring_window_to_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST,
        HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let hwnd = hwnd.0 as _;
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

#[cfg(not(windows))]
fn bring_window_to_front<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

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

fn handle_agent_notification_activated<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: String,
) {
    show_main_window(app);
    let _ = app.emit(
        NOTIFICATION_CLICKED_EVENT,
        AgentNotificationClickPayload { session_id },
    );
}

#[cfg(windows)]
fn set_windows_app_user_model_id() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id: Vec<u16> = std::ffi::OsStr::new(WINDOWS_APP_USER_MODEL_ID)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

#[cfg(windows)]
fn resolve_windows_notification_icon_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("icons/Square150x150Logo.png", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
        .or_else(|| {
            app.path()
                .resolve("icons/icon.ico", BaseDirectory::Resource)
                .ok()
                .filter(|path| path.exists())
        })
}

#[cfg(windows)]
fn register_windows_notification_app_id<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use winreg::enums::{RegType, HKEY_CURRENT_USER};
    use winreg::RegKey;
    use winreg::RegValue;

    fn expandable_string(value: &str) -> RegValue {
        let mut bytes = Vec::new();
        for unit in value.encode_utf16().chain(std::iter::once(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }

        RegValue {
            vtype: RegType::REG_EXPAND_SZ,
            bytes,
        }
    }

    let Some(icon_path) = resolve_windows_notification_icon_path(app) else {
        return;
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((app_id_key, _)) = hkcu.create_subkey(format!(
        r"Software\Classes\AppUserModelId\{}",
        WINDOWS_APP_USER_MODEL_ID
    )) else {
        return;
    };

    let icon_uri = icon_path.display().to_string();
    let icon_uri = icon_uri
        .strip_prefix(r"\\?\")
        .unwrap_or(&icon_uri)
        .to_string();
    let _ = app_id_key.set_raw_value("DisplayName", &expandable_string("CodeMUX"));
    let _ = app_id_key.set_raw_value("IconUri", &expandable_string(&icon_uri));
    let _ = app_id_key.set_raw_value("IconBackgroundColor", &expandable_string("0"));
    let _ = app_id_key.set_value("ShowInSettings", &1u32);
}

#[cfg(windows)]
fn repair_windows_start_menu_shortcut_icon() {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };

    let Some(current_exe) = current_exe.to_str() else {
        return;
    };

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$exePath = $env:CODEMUX_EXE_PATH
$appId = $env:CODEMUX_APP_USER_MODEL_ID
if (-not $exePath -or -not $appId) { exit 0 }
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
) | Where-Object { $_ }
$wsh = New-Object -ComObject WScript.Shell
$shell = New-Object -ComObject Shell.Application
foreach ($root in $roots) {
  $programs = Join-Path $root 'Programs'
  if (-not (Test-Path -LiteralPath $programs)) { continue }
  Get-ChildItem -LiteralPath $programs -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -eq 'CodeMUX' } |
    ForEach-Object {
      $shortcut = $wsh.CreateShortcut($_.FullName)
      $folder = $shell.Namespace($_.DirectoryName)
      $item = $folder.ParseName($_.Name)
      $shortcutAppId = $item.ExtendedProperty('System.AppUserModel.ID')
      if ($shortcut.TargetPath -eq $exePath -or $shortcutAppId -eq $appId) {
        $shortcut.IconLocation = "$exePath,0"
        $shortcut.Save()
      }
    }
}
"#;

    let _ = std::process::Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("CODEMUX_EXE_PATH", current_exe)
        .env("CODEMUX_APP_USER_MODEL_ID", WINDOWS_APP_USER_MODEL_ID)
        .status();
}

#[cfg(windows)]
fn refresh_windows_shell_icon_cache() {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let _ = std::process::Command::new("ie4uinit.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-show")
        .status();
}

#[cfg(windows)]
fn send_agent_notification_impl<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, IconCrop, Toast};

    register_windows_notification_app_id(&app);

    let app_for_activation = app.clone();
    let mut toast = Toast::new(WINDOWS_APP_USER_MODEL_ID)
        .title(&title)
        .text1(&body)
        .duration(Duration::Short);

    if let Ok(icon_path) = app
        .path()
        .resolve("icons/Square150x150Logo.png", BaseDirectory::Resource)
    {
        let toast_icon_path =
            std::path::PathBuf::from(icon_path.display().to_string().replace('\\', "/"));
        toast = toast.icon(&toast_icon_path, IconCrop::Square, "CodeMUX");
    }

    toast
        .on_activated(move |_| {
            handle_agent_notification_activated(&app_for_activation, session_id.clone());
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn send_agent_notification_impl<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    body: String,
    _session_id: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn send_agent_notification_command(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), String> {
    send_agent_notification_impl(app, title, body, session_id)
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
    commands::perf::init_tracing();

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        if should_register_single_instance_plugin(cfg!(debug_assertions)) {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                activate_main_window_for_second_instance(app);
            }));
        }
    }

    builder
        .on_window_event(handle_global_window_event)
        .plugin({
            let log_builder = tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("codemux".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .level_for("codemux_lib", log::LevelFilter::Debug)
                .rotation_strategy(RotationStrategy::KeepSome(10))
                .max_file_size(1_048_576)
                .timezone_strategy(TimezoneStrategy::UseLocal);
            #[cfg(feature = "tokio-console")]
            let log_builder = log_builder.skip_logger();
            log_builder.build()
        })
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

            #[cfg(windows)]
            set_windows_app_user_model_id();

            #[cfg(windows)]
            register_windows_notification_app_id(app.handle());

            #[cfg(windows)]
            repair_windows_start_menu_shortcut_icon();

            #[cfg(windows)]
            refresh_windows_shell_icon_cache();

            let conn = db::initialize(app.handle()).expect("Failed to initialize database");
            let config = config::load_config(app.handle());
            info!(
                target: "app",
                "Runtime initialized; providers={} theme={:?}",
                config.providers.len(),
                config.theme
            );

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
                provider_profile_operation_lock: Mutex::new(()),
                app_data_dir: app.path().app_data_dir()?,
            });
            app.manage(agent::commands::AgentState::default());
            app.manage(commands::terminal::TerminalState::default());

            let tray_menu = MenuBuilder::new(app)
                .text(TRAY_OPEN_ID, "打开 CodeMUX")
                .separator()
                .text(TRAY_QUIT_ID, "退出")
                .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .tooltip("CodeMUX")
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
            commands::provider::set_default_open_target,
            commands::provider::upsert_agent_provider_profile,
            commands::provider::activate_agent_provider_profile,
            commands::provider::activate_default_claude_supplier,
            commands::provider::activate_default_codex_supplier,
            commands::provider::activate_default_opencode_supplier,
            commands::provider::set_active_agent_profile_model,
            commands::provider::delete_agent_provider_profile,
            commands::provider::fetch_agent_profile_models,
            commands::provider::test_agent_provider_profile,
            commands::provider::fetch_provider_models,
            commands::provider::test_provider,
            commands::app::get_log_directory,
            commands::app::get_app_data_directory,
            commands::app::check_development_environment,
            commands::app::get_log_files,
            commands::app::read_log_file,
            commands::agent_runtime_check::check_agent_runtimes,
            commands::agent_runtime_check::upgrade_agent_runtime,
            commands::agent_runtime_check::probe_agent_installations,
            commands::agent_runtime_check::get_user_home_directory,
            show_main_window_command,
            send_agent_notification_command,
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
            commands::usage::get_usage_stats,
            commands::usage::get_usage_token_breakdown,
            commands::project::create_project,
            commands::project::get_all_projects,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::file::read_file,
            commands::file::write_file,
            commands::file::delete_file,
            commands::file::open_in_explorer,
            commands::file::open_project_path,
            commands::file::list_directory,
            commands::file::read_home_file,
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
            agent::commands::respond_to_agent_permission,
            agent::commands::delete_claude_session_files,
            agent::commands::delete_codex_session_files,
            agent::commands::load_claude_session_events,
            agent::commands::load_codex_session_events,
            agent::commands::load_opencode_session_events,
            agent::commands::delete_opencode_session,
            agent::commands::load_agent_latest_token_usage,
            agent::commands::rewind_agent_session,
            agent::commands::get_agent_session_info,
            agent::commands::start_codex_proxy,
            agent::commands::stop_codex_proxy,
            agent::commands::get_codex_proxy_port,
            skills::commands::list_installed_skills,
            skills::commands::uninstall_skill,
            skills::commands::toggle_skill,
            skills::commands::toggle_skill_app,
            skills::commands::list_importable_skills,
            skills::commands::import_skills_from_apps,
            skills::commands::get_skill_content,
            skills::commands::scan_disk_skills,
            skills::commands::register_skill_from_disk,
            skills::commands::get_enabled_skill_names,
            commands::perf::get_tokio_console_info,
            commands::perf::export_perf_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        should_activate_main_window_for_second_instance, should_hide_to_tray,
        should_register_single_instance_plugin,
    };

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

    #[test]
    fn registers_single_instance_only_for_production_builds() {
        assert!(!should_register_single_instance_plugin(true));
        assert!(should_register_single_instance_plugin(false));
    }
}
