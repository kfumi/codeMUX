pub mod types;

use crate::config::types::AppConfig;
use log::warn;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    app_dir.join("config.json")
}

fn write_default_config_to_path(config_path: &Path) -> AppConfig {
    let config = AppConfig::default();
    let _ = save_config_to_path(config_path, &config);
    config
}

fn load_config_from_path(config_path: &Path) -> AppConfig {
    if config_path.exists() {
        let content = std::fs::read_to_string(config_path).expect("Failed to read config");
        match serde_json::from_str::<AppConfig>(&content) {
            Ok(config) => config,
            Err(error) => {
                warn!(
                    target: "config",
                    "Failed to deserialize config at {}: {}. Preserving existing file and using in-memory defaults.",
                    config_path.display(),
                    error
                );
                AppConfig::default()
            }
        }
    } else {
        write_default_config_to_path(config_path)
    }
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let config_path = get_config_path(app);
    load_config_from_path(&config_path)
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(app);
    save_config_to_path(&config_path, config)
}

fn save_config_to_path(config_path: &Path, config: &AppConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::load_config_from_path;

    #[test]
    fn preserves_unreadable_config_file_on_deserialize_failure() {
        let temp_dir = std::env::temp_dir().join(format!("codemux-config-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("config.json");
        let invalid_content = "{ invalid json";
        std::fs::write(&config_path, invalid_content).unwrap();

        let config = load_config_from_path(&config_path);
        let preserved = std::fs::read_to_string(&config_path).unwrap();

        assert_eq!(config.agent_defaults.default_agent_kind.as_str(), "claude_code");
        assert_eq!(preserved, invalid_content);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
