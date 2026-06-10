pub mod types;

use crate::config::types::AppConfig;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    app_dir.join("config.json")
}

fn write_default_config(app: &AppHandle) -> AppConfig {
    let config = AppConfig::default();
    let _ = save_config(app, &config);
    config
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let config_path = get_config_path(app);

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).expect("Failed to read config");
        match serde_json::from_str::<AppConfig>(&content) {
            Ok(config) => config,
            Err(_) => {
                // Old config format or corrupted 鈥?reset to default
                write_default_config(app)
            }
        }
    } else {
        write_default_config(app)
    }
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(app);
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}
