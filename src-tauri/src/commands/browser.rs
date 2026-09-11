use tauri::{AppHandle, State};

use crate::browser::manager::{self, BrowserPageBounds, BrowserState};
use crate::config::types::BrowserControlConfig;
use crate::paths::PathRoots;

// Child WebView create/mutate must be async. On Windows, WebviewBuilder / add_child
// deadlocks inside a synchronous command because WebView2 needs the UI thread to
// pump while the command is still running on that same thread (wry#583).

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserState>,
    browser_id: String,
    url: String,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    // 权威配置在 daemon 侧随时可能被改写,壳内不再持有缓存;
    // browser 操作低频,调用点现读现传。
    let roots = PathRoots::from_app(&app)?;
    let config = crate::config::load_config(&roots);
    manager::create_page(&app, &state, &config, browser_id, url, bounds)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_destroy(
    app: AppHandle,
    state: State<'_, BrowserState>,
    browser_id: String,
) -> Result<(), String> {
    manager::destroy_page(&app, &state, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    manager::navigate_page(&app, &state, browser_id, url)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_back(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::back_page(&app, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_forward(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::forward_page(&app, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::reload_page(&app, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_set_bounds(
    app: AppHandle,
    browser_id: String,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    manager::set_page_bounds(&app, &browser_id, bounds)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_show(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::show_page(&app, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_hide(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::hide_page(&app, &browser_id)
}

#[tauri::command]
pub async fn browser_evaluate(
    app: AppHandle,
    browser_id: String,
    script: String,
) -> Result<String, String> {
    manager::evaluate_script(app, browser_id, script).await
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_open_devtools(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::open_devtools(&app, &browser_id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_set_zoom(
    app: AppHandle,
    browser_id: String,
    factor: f64,
) -> Result<(), String> {
    manager::set_page_zoom(&app, &browser_id, factor)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn browser_clear_data(app: AppHandle, scope: String) -> Result<(), String> {
    manager::clear_data(&app, &scope)
}

#[tauri::command]
pub fn set_browser_control(app: AppHandle, settings: BrowserControlConfig) -> Result<(), String> {
    // 壳内 config 缓存会陈旧(daemon 是权威写方):现读 → 改字段 → 整份保存,
    // 避免用陈旧快照覆盖 daemon 侧的其它字段。
    let roots = PathRoots::from_app(&app)?;
    let mut config = crate::config::load_config(&roots);
    config.browser = settings;
    crate::config::save_config(&roots, &config)?;
    Ok(())
}
