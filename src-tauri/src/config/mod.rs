pub mod types;

use crate::config::types::AppConfig;
use crate::provider_profiles::{migrate_legacy_providers, AgentProfileRegistry};
use log::warn;
#[cfg(unix)]
use std::fs::File;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

trait ConfigFileOps {
    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()>;
    fn replace(&self, source: &Path, destination: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
    fn sync_dir(&self, path: &Path) -> io::Result<()>;
}

struct StdConfigFileOps;

impl ConfigFileOps for StdConfigFileOps {
    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()
    }

    fn replace(&self, source: &Path, destination: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            replace_windows_file(source, destination)
        }
        #[cfg(not(windows))]
        {
            fs::rename(source, destination)
        }
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            File::open(path)?.sync_all()
        }
        #[cfg(windows)]
        {
            // MoveFileExW 的 WRITE_THROUGH 标志负责持久化替换操作。
            let _ = path;
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "当前平台不支持目录持久化同步",
            ))
        }
    }
}

#[cfg(windows)]
fn replace_windows_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: 路径均以 NUL 结尾，且 Windows API 不会保留指针。
    unsafe {
        if MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    app_dir.join("config.json")
}

fn write_default_config_to_path(config_path: &Path) -> AppConfig {
    let config = AppConfig::default();
    let _ = save_config_to_path(config_path, &config);
    config
}

fn backup_unreadable_config(config_path: &Path) -> Result<PathBuf, String> {
    let backup_path =
        config_path.with_extension(format!("json.unreadable.{}.bak", uuid::Uuid::new_v4()));
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
                Ok(config) => migrate_legacy_config(config),
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
    save_config_to_path_with_file_ops(config_path, config, &StdConfigFileOps)
}

fn save_config_to_path_with_file_ops<O: ConfigFileOps>(
    config_path: &Path,
    config: &AppConfig,
    file_ops: &O,
) -> Result<(), String> {
    if !config.profile_registry_is_derived {
        if let Some(error) = &config.profile_registry_validation_error {
            return Err(format!("智能体供应商档案无效，拒绝覆盖原配置: {}", error));
        }
        config
            .agent_profile_registry
            .validate()
            .map_err(|error| format!("智能体供应商档案无效，拒绝覆盖原配置: {}", error))?;
    }

    let mut persisted = config.clone();
    if persisted.profile_registry_is_derived {
        persisted.agent_profile_registry = AgentProfileRegistry::default();
        persisted.profile_registry_is_derived = false;
    }
    persisted.profile_registry_validation_error = None;

    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let parent = config_path
        .parent()
        .ok_or_else(|| "Failed to write config: missing parent directory".to_string())?;
    let file_name = config_path
        .file_name()
        .ok_or_else(|| "Failed to write config: missing file name".to_string())?
        .to_string_lossy();
    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    if let Err(error) = file_ops.write_file_sync(&temporary_path, content.as_bytes()) {
        let _ = file_ops.remove_file(&temporary_path);
        return Err(format!("Failed to write config: {}", error));
    }
    if let Err(error) = file_ops.replace(&temporary_path, config_path) {
        let _ = file_ops.remove_file(&temporary_path);
        return Err(format!("Failed to replace config: {}", error));
    }
    file_ops
        .sync_dir(parent)
        .map_err(|error| format!("Failed to sync config directory: {}", error))?;
    Ok(())
}

fn migrate_legacy_config(mut config: AppConfig) -> AppConfig {
    if !config.agent_profile_registry.is_empty() {
        if let Err(error) = config.agent_profile_registry.validate() {
            if config.providers.is_empty() {
                warn!(
                    target: "config",
                    "Persisted agent profile registry is invalid and no legacy providers are available: {}. Keeping the original registry and refusing later saves.",
                    error
                );
                config.profile_registry_validation_error = Some(error);
                return config;
            }

            warn!(
                target: "config",
                "Persisted agent profile registry is invalid: {}. Re-deriving it from legacy providers.",
                error
            );
            config.agent_profile_registry = AgentProfileRegistry::default();
            config.profile_registry_validation_error = Some(error);
        } else {
            return config;
        }
    }

    if config.providers.is_empty() {
        return config;
    }

    match migrate_legacy_providers(&config.providers, config.active_provider_id.as_deref()) {
        Ok(Some(registry)) => {
            config.agent_profile_registry = registry;
            config.profile_registry_is_derived = true;
            config.profile_registry_validation_error = None;
        }
        Ok(None) => {
            warn!(
                target: "config",
                "Legacy providers contain no usable URL; no agent profile registry was derived."
            );
        }
        Err(error) => {
            warn!(
                target: "config",
                "Failed to derive agent profile registry from legacy providers: {}. Keeping legacy providers unchanged.",
                error
            );
            config.profile_registry_validation_error = Some(error);
        }
    }

    config
}

#[cfg(test)]
mod tests {
    use super::{
        load_config_from_path, save_config_to_path, save_config_to_path_with_file_ops,
        ConfigFileOps,
    };
    use crate::config::types::AppConfig;
    use std::{io, path::Path};

    fn temp_config_dir() -> std::path::PathBuf {
        let temp_dir =
            std::env::temp_dir().join(format!("codemux-config-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        temp_dir
    }

    struct ReplaceFailsFileOps;

    impl ConfigFileOps for ReplaceFailsFileOps {
        fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
            use std::io::Write;

            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            file.write_all(content)?;
            file.flush()?;
            file.sync_all()
        }

        fn replace(&self, _source: &Path, _destination: &Path) -> io::Result<()> {
            Err(io::Error::other("注入的替换失败"))
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            std::fs::remove_file(path)
        }

        fn sync_dir(&self, _path: &Path) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn 配置保存替换失败时保留原文件() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let original = b"{\"preserved\":\"old-config\"}";
        std::fs::write(&config_path, original).unwrap();

        let error = save_config_to_path_with_file_ops(
            &config_path,
            &AppConfig::default(),
            &ReplaceFailsFileOps,
        )
        .unwrap_err();

        assert!(error.contains("Failed to replace config"));
        assert_eq!(std::fs::read(&config_path).unwrap(), original);
        assert_eq!(
            std::fs::read_dir(&temp_dir).unwrap().count(),
            1,
            "替换失败时应删除临时文件"
        );

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
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
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".unreadable.")
            })
            .unwrap();
        let preserved = std::fs::read_to_string(&backup_path).unwrap();

        assert_eq!(
            config.agent_defaults.default_agent_kind.as_str(),
            "claude_code"
        );
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
        save_config_to_path(
            &config_path,
            &AppConfig {
                theme: config.theme,
                ..config
            },
        )
        .unwrap();

        let current = std::fs::read_to_string(&config_path).unwrap();
        let backup_path = std::fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".unreadable.")
            })
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
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".unreadable.")
            })
            .unwrap();
        let preserved = std::fs::read(&backup_path).unwrap();

        assert_eq!(
            config.agent_defaults.default_agent_kind.as_str(),
            "claude_code"
        );
        assert_ne!(current, invalid_bytes);
        assert_eq!(preserved, invalid_bytes);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn migrates_legacy_provider_with_two_urls_into_three_agent_profiles() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let legacy = serde_json::json!({
            "providers": [{
                "id": "legacy-provider",
                "name": "旧供应商",
                "api_key": "secret",
                "anthropic_base_url": "https://anthropic.example/v1",
                "openai_base_url": "https://openai.example/v1",
                "default_model": "model-a",
                "models": ["model-a", "model-b"],
                "context_1m": true,
                "codex_needs_proxy": true
            }],
            "active_provider_id": "legacy-provider",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);
        let raw = serde_json::to_value(&config).unwrap();
        let registry = &raw["agent_profile_registry"];
        let profiles = registry["profiles"].as_array().unwrap();
        let codex = profiles
            .iter()
            .find(|profile| profile["agent_kind"] == "codex")
            .unwrap();
        let opencode = profiles
            .iter()
            .find(|profile| profile["agent_kind"] == "opencode")
            .unwrap();

        assert_eq!(profiles.len(), 3);
        assert!(config
            .agent_profile_registry
            .profiles
            .iter()
            .all(|profile| profile.validate().is_ok()));
        assert_eq!(registry["active_profile_ids"]["codex"], codex["id"].clone());
        assert_eq!(
            codex["native_config"]["codex_needs_proxy"],
            serde_json::json!(true)
        );
        assert_eq!(opencode["native_config"]["type"], "opencode");
        assert_eq!(
            codex["models"],
            serde_json::json!([
                { "id": "model-a", "name": "model-a", "context_window": null },
                { "id": "model-b", "name": "model-b", "context_window": null }
            ])
        );
        assert_eq!(raw["providers"], legacy["providers"]);
        assert_eq!(raw["active_provider_id"], legacy["active_provider_id"]);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(persisted, legacy);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn migrates_legacy_default_model_into_profile_model_list() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let legacy = serde_json::json!({
            "providers": [{
                "id": "legacy-provider",
                "name": "旧供应商",
                "api_key": "secret",
                "anthropic_base_url": "",
                "openai_base_url": "https://openai.example/v1",
                "default_model": "model-a"
            }],
            "active_provider_id": "legacy-provider",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);
        let raw = serde_json::to_value(&config).unwrap();
        let profiles = raw["agent_profile_registry"]["profiles"]
            .as_array()
            .unwrap();

        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().all(|profile| profile["models"]
            == serde_json::json!([
                { "id": "model-a", "name": "model-a", "context_window": null }
            ])));
        assert!(profiles
            .iter()
            .all(|profile| profile["default_model"] == serde_json::json!("model-a")));

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn preserves_unmappable_legacy_provider_while_migrating_other_entries() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let legacy = serde_json::json!({
            "providers": [
                {
                    "id": "migratable",
                    "name": "可迁移供应商",
                    "api_key": "migratable-key",
                    "anthropic_base_url": "https://anthropic.example",
                    "openai_base_url": "",
                    "default_model": "claude-model",
                    "models": ["claude-model"]
                },
                {
                    "id": "unmappable",
                    "name": "待人工处理供应商",
                    "api_key": "unmappable-key",
                    "anthropic_base_url": "",
                    "openai_base_url": "",
                    "default_model": "unknown-model",
                    "models": ["unknown-model"]
                }
            ],
            "active_provider_id": "unmappable",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);

        assert_eq!(config.agent_profile_registry.profiles.len(), 1);
        assert_eq!(config.providers.len(), 2);
        assert_eq!(config.providers[1].id, "unmappable");
        assert_eq!(config.providers[1].name, "待人工处理供应商");
        assert_eq!(config.providers[1].api_key, "unmappable-key");
        assert_eq!(config.providers[1].models, vec!["unknown-model"]);
        assert_eq!(config.active_provider_id.as_deref(), Some("unmappable"));

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn legacy_migration_is_idempotent_across_repeated_loads() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let legacy = serde_json::json!({
            "providers": [{
                "id": "legacy-provider",
                "name": "旧供应商",
                "api_key": "secret",
                "anthropic_base_url": "https://anthropic.example/v1",
                "openai_base_url": "https://openai.example/v1",
                "default_model": "model-a",
                "models": ["model-a"]
            }],
            "active_provider_id": "legacy-provider",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let first = load_config_from_path(&config_path);
        let second = load_config_from_path(&config_path);

        assert_eq!(first.agent_profile_registry, second.agent_profile_registry);
        assert_eq!(
            serde_json::to_value(&second.providers).unwrap(),
            serde_json::to_value(&first.providers).unwrap()
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config_path).unwrap())
                .unwrap(),
            legacy
        );

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn saving_a_derived_registry_keeps_legacy_providers_authoritative_on_disk() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let legacy = serde_json::json!({
            "providers": [{
                "id": "legacy-provider",
                "name": "旧供应商",
                "api_key": "secret",
                "anthropic_base_url": "https://anthropic.example/v1",
                "openai_base_url": "",
                "default_model": "model-a",
                "models": ["model-a"]
            }],
            "active_provider_id": "legacy-provider",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let mut config = load_config_from_path(&config_path);
        config.compact_ai_output = true;
        save_config_to_path(&config_path, &config).unwrap();

        let after_first_save: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert!(after_first_save["agent_profile_registry"]["profiles"]
            .as_array()
            .unwrap()
            .is_empty());
        let persisted_provider = &after_first_save["providers"][0];
        let legacy_provider = &legacy["providers"][0];
        for field in [
            "id",
            "name",
            "api_key",
            "anthropic_base_url",
            "openai_base_url",
            "default_model",
            "models",
        ] {
            assert_eq!(persisted_provider[field], legacy_provider[field]);
        }
        assert_eq!(
            after_first_save["active_provider_id"],
            legacy["active_provider_id"]
        );

        config.providers[0].default_model = "model-b".to_string();
        save_config_to_path(&config_path, &config).unwrap();
        let reloaded = load_config_from_path(&config_path);

        assert_eq!(
            reloaded.agent_profile_registry.profiles[0].default_model,
            "model-b"
        );

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn invalid_persisted_registry_is_rederived_from_legacy_providers() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let raw = serde_json::json!({
            "agent_profile_registry": {
                "profiles": [{
                    "id": "invalid-profile",
                    "agent_kind": "claude_code",
                    "name": "无效档案",
                    "models": [],
                    "default_model": "invalid-model",
                    "native_config": {
                        "type": "codex",
                        "api_key": "secret",
                        "openai_base_url": "https://invalid.example/v1"
                    }
                }],
                "active_profile_ids": { "claude_code": "invalid-profile" }
            },
            "providers": [{
                "id": "legacy-provider",
                "name": "旧供应商",
                "api_key": "legacy-key",
                "anthropic_base_url": "https://anthropic.example/v1",
                "openai_base_url": "",
                "default_model": "legacy-model",
                "models": ["legacy-model"]
            }],
            "active_provider_id": "legacy-provider",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);

        assert_eq!(config.agent_profile_registry.profiles.len(), 1);
        assert_eq!(
            config.agent_profile_registry.profiles[0].default_model,
            "legacy-model"
        );
        assert!(config.agent_profile_registry.validate().is_ok());

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn invalid_persisted_registry_without_legacy_providers_cannot_be_saved() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let raw = serde_json::json!({
            "agent_profile_registry": {
                "profiles": [{
                    "id": "invalid-profile",
                    "agent_kind": "claude_code",
                    "name": "无效档案",
                    "models": [],
                    "default_model": "invalid-model",
                    "native_config": {
                        "type": "codex",
                        "api_key": "secret",
                        "openai_base_url": "https://invalid.example/v1"
                    }
                }],
                "active_profile_ids": { "claude_code": "invalid-profile" }
            },
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let mut config = load_config_from_path(&config_path);
        config.compact_ai_output = true;
        let error = save_config_to_path(&config_path, &config).unwrap_err();

        assert!(error.contains("智能体供应商档案无效"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config_path).unwrap())
                .unwrap(),
            raw
        );

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn invalid_registry_with_unmappable_legacy_providers_cannot_be_overwritten() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let raw = serde_json::json!({
            "agent_profile_registry": {
                "profiles": [{
                    "id": "invalid-profile",
                    "agent_kind": "claude_code",
                    "name": "无效档案",
                    "models": [],
                    "default_model": "invalid-model",
                    "native_config": {
                        "type": "codex",
                        "api_key": "secret",
                        "openai_base_url": "https://invalid.example/v1"
                    }
                }],
                "active_profile_ids": { "claude_code": "invalid-profile" }
            },
            "providers": [{
                "id": "unmappable",
                "name": "待人工处理供应商",
                "api_key": "legacy-key",
                "anthropic_base_url": "",
                "openai_base_url": "",
                "default_model": "unknown-model",
                "models": ["unknown-model"]
            }],
            "active_provider_id": "unmappable",
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let mut config = load_config_from_path(&config_path);
        config.compact_ai_output = true;
        let error = save_config_to_path(&config_path, &config).unwrap_err();

        assert!(error.contains("智能体供应商档案无效"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config_path).unwrap())
                .unwrap(),
            raw
        );

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn round_trips_new_agent_profile_registry_without_legacy_fields() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let new_config = serde_json::json!({
            "agent_profile_registry": {
                "profiles": [{
                    "id": "codex-profile",
                    "agent_kind": "codex",
                    "name": "Codex",
                    "note": "需要检查原生高级配置",
                    "models": [{
                        "id": "gpt-5",
                        "name": "GPT-5",
                        "context_window": 400000
                    }],
                    "default_model": "gpt-5",
                    "native_config": {
                        "type": "codex",
                        "api_key": "secret",
                        "openai_base_url": "https://openai.example/v1",
                        "codex_needs_proxy": true,
                        "advanced_config": null,
                        "requires_review": true
                    }
                }],
                "active_profile_ids": { "codex": "codex-profile" }
            },
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec(&new_config).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);
        save_config_to_path(&config_path, &config).unwrap();
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();

        assert_eq!(
            persisted["agent_profile_registry"],
            new_config["agent_profile_registry"]
        );
        assert_eq!(persisted.get("providers"), None);
        assert_eq!(persisted.get("active_provider_id"), None);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
