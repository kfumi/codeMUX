use tauri::{AppHandle, State};

use crate::browser::manager::{self, BrowserPageBounds, BrowserState};
use crate::config;
use crate::config::types::BrowserControlConfig;
use crate::AppState;

#[tauri::command]
pub fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserState>,
    config_state: State<'_, AppState>,
    browser_id: String,
    url: String,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    let config = config_state.config.lock().unwrap().clone();
    manager::create_page(&app, &state, &config, browser_id, url, bounds)
}

#[tauri::command]
pub fn browser_destroy(
    app: AppHandle,
    state: State<'_, BrowserState>,
    browser_id: String,
) -> Result<(), String> {
    manager::destroy_page(&app, &state, &browser_id)
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    manager::navigate_page(&app, &state, browser_id, url)
}

#[tauri::command]
pub fn browser_back(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::back_page(&app, &browser_id)
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::forward_page(&app, &browser_id)
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::reload_page(&app, &browser_id)
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    browser_id: String,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    manager::set_page_bounds(&app, &browser_id, bounds)
}

#[tauri::command]
pub fn browser_show(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::show_page(&app, &browser_id)
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, browser_id: String) -> Result<(), String> {
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
pub fn browser_open_devtools(app: AppHandle, browser_id: String) -> Result<(), String> {
    manager::open_devtools(&app, &browser_id)
}

#[tauri::command]
pub fn browser_clear_data(app: AppHandle, scope: String) -> Result<(), String> {
    manager::clear_data(&app, &scope)
}

#[tauri::command]
pub fn set_browser_control(
    state: State<'_, AppState>,
    app: AppHandle,
    settings: BrowserControlConfig,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.browser = settings;
    config::save_config(&app, &config)?;
    Ok(())
}
