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

fn backup_unreadable_config(config_path: &Path) -> Result<PathBuf, String> {
    let backup_path = config_path.with_extension(format!(
        "json.unreadable.{}.bak",
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(config_path, &backup_path).map_err(|e| {
        format!(
            "Failed to preserve unreadable config {}: {}",
            config_path.display(),
            e
        )
    })?;
    Ok(backup_path)
}

fn load_config_from_path(config_path: &Path) -> AppConfig {
    if config_path.exists() {
        match std::fs::read(config_path) {
            Ok(content) => match serde_json::from_slice::<AppConfig>(&content) {
                Ok(config) => config,
                Err(error) => {
                    let backup_path = backup_unreadable_config(config_path).ok();
                    warn!(
                        target: "config",
                        "Failed to deserialize config at {}: {}. Backed up unreadable config to {:?} and using fresh defaults.",
                        config_path.display(),
                        error,
                        backup_path.as_ref().map(|path| path.display().to_string())
                    );
                    write_default_config_to_path(config_path)
                }
            },
            Err(error) => {
                let backup_path = backup_unreadable_config(config_path).ok();
                warn!(
                    target: "config",
                    "Failed to read config at {}: {}. Backed up unreadable config to {:?} and using fresh defaults.",
                    config_path.display(),
                    error,
                    backup_path.as_ref().map(|path| path.display().to_string())
                );
                write_default_config_to_path(config_path)
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
    use super::{load_config_from_path, save_config_to_path};
    use crate::config::types::AppConfig;

    fn temp_config_dir() -> std::path::PathBuf {
        let temp_dir = std::env::temp_dir().join(format!("codemux-config-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        temp_dir
    }

    #[test]
    fn preserves_unreadable_config_file_on_deserialize_failure() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let invalid_content = "{ invalid json";
        std::fs::write(&config_path, invalid_content).unwrap();

        let config = load_config_from_path(&config_path);
        let rewritten = std::fs::read_to_string(&config_path).unwrap();
        let backup_path = std::fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.file_name().unwrap().to_string_lossy().contains(".unreadable."))
            .unwrap();
        let preserved = std::fs::read_to_string(&backup_path).unwrap();

        assert_eq!(config.agent_defaults.default_agent_kind.as_str(), "claude_code");
        assert_ne!(rewritten, invalid_content);
        assert_eq!(preserved, invalid_content);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn save_after_unreadable_config_load_keeps_backup_of_original_file() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let invalid_content = "{ invalid json";
        std::fs::write(&config_path, invalid_content).unwrap();

        let config = load_config_from_path(&config_path);
        save_config_to_path(&config_path, &AppConfig { theme: config.theme, ..config }).unwrap();

        let current = std::fs::read_to_string(&config_path).unwrap();
        let backup_path = std::fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.file_name().unwrap().to_string_lossy().contains(".unreadable."))
            .unwrap();
        let preserved = std::fs::read_to_string(&backup_path).unwrap();

        assert!(current.contains("\"theme\""));
        assert_eq!(preserved, invalid_content);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn preserves_non_utf8_config_bytes_via_backup_recovery() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let invalid_bytes = vec![0xff, 0xfe, 0xfd, 0x00];
        std::fs::write(&config_path, &invalid_bytes).unwrap();

        let config = load_config_from_path(&config_path);
        let current = std::fs::read(&config_path).unwrap();
        let backup_path = std::fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.file_name().unwrap().to_string_lossy().contains(".unreadable."))
            .unwrap();
        let preserved = std::fs::read(&backup_path).unwrap();

        assert_eq!(config.agent_defaults.default_agent_kind.as_str(), "claude_code");
        assert_ne!(current, invalid_bytes);
        assert_eq!(preserved, invalid_bytes);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
