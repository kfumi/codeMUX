pub mod types;

use tauri::{AppHandle, Manager};
use std::path::PathBuf;
use crate::config::types::AppConfig;

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    app_dir.join("config.json")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let config_path = get_config_path(app);

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).expect("Failed to read config");
        serde_json::from_str(&content).expect("Failed to parse config")
    } else {
        let config = AppConfig::default();
        let _ = save_config(app, &config);
        config
    }
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(app);
    let content = serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}
