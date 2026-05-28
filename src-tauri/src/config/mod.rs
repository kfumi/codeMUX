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
        let mut config: AppConfig = serde_json::from_str(&content).expect("Failed to parse config");

        // Migration: ensure Anthropic provider exists
        if !config.providers.iter().any(|p| p.id == "anthropic") {
            config.providers.push(types::ProviderConfig {
                id: "anthropic".to_string(),
                name: "Anthropic (Claude)".to_string(),
                api_type: types::ApiType::Claude,
                api_key: String::new(),
                endpoint_url: "https://api.anthropic.com".to_string(),
                default_model: "claude-sonnet-4-6".to_string(),
                is_active: false,
            });
            let _ = save_config(app, &config);
        }

        config
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
