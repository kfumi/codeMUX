pub mod types;

use crate::config::types::AppConfig;
use crate::model_providers::validate_provider;
use crate::provider_profiles::AgentProfileRegistry;
use log::warn;
#[cfg(unix)]
use std::fs::File;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

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

fn get_config_path(roots: &crate::paths::PathRoots) -> PathBuf {
    roots
        .ensure_app_data_dir()
        .expect("Failed to create app data dir");
    roots.config_path()
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
                Ok(config) => {
                    let had_legacy = !config.agent_profile_registry.profiles.is_empty()
                        || !config.providers.is_empty();
                    let before_active = config.active_provider_id.clone();
                    let config = discard_legacy_provider_config(config);
                    let active_changed = before_active != config.active_provider_id;
                    if had_legacy || active_changed {
                        // Persist the cleaned shape so old registry/providers leave the on-disk file.
                        if let Err(error) = save_config_to_path(config_path, &config) {
                            warn!(
                                target: "config",
                                "Failed to persist discarded legacy provider config: {}",
                                error
                            );
                        }
                    }
                    config
                }
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

pub fn load_config(roots: &crate::paths::PathRoots) -> AppConfig {
    let config_path = get_config_path(roots);
    load_config_from_path(&config_path)
}

pub fn save_config(roots: &crate::paths::PathRoots, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(roots);
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
    for provider in &config.model_providers {
        validate_provider(provider)
            .map_err(|error| format!("模型供应商无效，拒绝覆盖原配置: {}", error))?;
    }
    if let Some(active_id) = &config.active_provider_id {
        if !config
            .model_providers
            .iter()
            .any(|provider| provider.id == *active_id)
        {
            return Err(format!(
                "active_provider_id 指向不存在的供应商: {}",
                active_id
            ));
        }
    }

    let mut persisted = config.clone();
    // Never persist legacy profile/provider fields (serde skip_serializing also covers this).
    persisted.agent_profile_registry = AgentProfileRegistry::default();
    persisted.providers.clear();
    persisted.profile_registry_is_derived = false;
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
    // The replace above is the logical commit point. Returning an error here
    // would make callers compensate already-committed native configuration.
    if let Err(error) = file_ops.sync_dir(parent) {
        warn!(
            target: "config",
            "Config replaced but parent directory sync failed: {}",
            error
        );
    }
    Ok(())
}

/// ADR 0005: drop AgentProviderProfile registry and legacy unified providers without migrating.
fn discard_legacy_provider_config(mut config: AppConfig) -> AppConfig {
    if !config.agent_profile_registry.profiles.is_empty() || !config.providers.is_empty() {
        warn!(
            target: "config",
            "Discarding legacy agent_profile_registry ({} profiles) and providers ({} entries); no migration (ADR 0005).",
            config.agent_profile_registry.profiles.len(),
            config.providers.len()
        );
    }
    config.agent_profile_registry = AgentProfileRegistry::default();
    config.providers.clear();
    config.profile_registry_is_derived = false;
    config.profile_registry_validation_error = None;

    if let Some(active_id) = config.active_provider_id.clone() {
        if !config
            .model_providers
            .iter()
            .any(|provider| provider.id == active_id)
        {
            config.active_provider_id = None;
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

    struct SyncDirFailsFileOps;

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

    impl ConfigFileOps for SyncDirFailsFileOps {
        fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
            ReplaceFailsFileOps.write_file_sync(path, content)
        }

        fn replace(&self, source: &Path, destination: &Path) -> io::Result<()> {
            #[cfg(windows)]
            {
                std::fs::remove_file(destination)?;
            }
            std::fs::rename(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            std::fs::remove_file(path)
        }

        fn sync_dir(&self, _path: &Path) -> io::Result<()> {
            Err(io::Error::other("注入的目录同步失败"))
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
    fn 配置替换成功后目录同步失败仍视为已提交() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        std::fs::write(&config_path, b"{\"previous\":true}").unwrap();

        save_config_to_path_with_file_ops(
            &config_path,
            &AppConfig::default(),
            &SyncDirFailsFileOps,
        )
        .expect("替换完成后不能将目录同步告警误报为未提交");

        let saved: AppConfig =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(
            saved.agent_profile_registry,
            AppConfig::default().agent_profile_registry
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
    fn discards_legacy_registry_and_providers_without_migration() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let raw = serde_json::json!({
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
            "agent_profile_registry": {
                "profiles": [{
                    "id": "codex-profile",
                    "agent_kind": "codex",
                    "name": "Codex",
                    "note": "",
                    "models": [{ "id": "gpt-5" }],
                    "default_model": "gpt-5",
                    "native_config": {
                        "type": "codex",
                        "api_key": "secret",
                        "openai_base_url": "https://openai.example/v1"
                    }
                }],
                "active_profile_ids": { "codex": "codex-profile" }
            },
            "theme": "System"
        });
        std::fs::write(&config_path, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();

        let config = load_config_from_path(&config_path);

        assert!(config.model_providers.is_empty());
        assert!(config.agent_profile_registry.profiles.is_empty());
        assert!(config.providers.is_empty());
        assert!(config.active_provider_id.is_none());

        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(persisted.get("providers"), None);
        assert_eq!(persisted.get("agent_profile_registry"), None);
        assert!(persisted
            .get("model_providers")
            .and_then(|value| value.as_array())
            .map(|items| items.is_empty())
            .unwrap_or(false));

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn round_trips_model_providers() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let mut config = AppConfig::default();
        config
            .model_providers
            .push(crate::model_providers::ModelProvider {
                id: "deepseek-1".to_string(),
                name: "DeepSeek".to_string(),
                enabled: true,
                api_key: "sk-test".to_string(),
                api_key_configured: false,
                endpoints: vec![
                    crate::model_providers::ProtocolEndpoint {
                        protocol: crate::model_providers::Protocol::Anthropic,
                        base_url: "https://api.deepseek.com/anthropic".to_string(),
                        api_key_override: None,
                        codex_needs_proxy: None,
                    },
                    crate::model_providers::ProtocolEndpoint {
                        protocol: crate::model_providers::Protocol::OpenaiCompatible,
                        base_url: "https://api.deepseek.com".to_string(),
                        api_key_override: None,
                        codex_needs_proxy: Some(false),
                    },
                ],
                models: vec![crate::model_providers::ProviderModel {
                    id: "deepseek-v4-flash".to_string(),
                    name: Some("Flash".to_string()),
                    context_1m: None,
                    context_window: None,
                    max_input_tokens: None,
                    max_output_tokens: None,
                    input_modalities: None,
                    supports_vision: None,
                }],
                default_model: "deepseek-v4-flash".to_string(),
                builtin_template_id: Some("deepseek".to_string()),
                opencode_provider_key: None,
                opencode_npm: None,
            });
        config.active_provider_id = Some("deepseek-1".to_string());
        save_config_to_path(&config_path, &config).unwrap();

        let loaded = load_config_from_path(&config_path);
        assert_eq!(loaded.model_providers.len(), 1);
        assert_eq!(loaded.model_providers[0].id, "deepseek-1");
        assert_eq!(loaded.active_provider_id.as_deref(), Some("deepseek-1"));
        assert_eq!(loaded.model_providers[0].endpoints.len(), 2);

        let _ = std::fs::remove_file(&config_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn rejects_save_when_active_provider_is_missing() {
        let temp_dir = temp_config_dir();
        let config_path = temp_dir.join("config.json");
        let config = AppConfig {
            active_provider_id: Some("missing".to_string()),
            ..Default::default()
        };
        let error = save_config_to_path(&config_path, &config).unwrap_err();
        assert!(error.contains("active_provider_id"));
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn load_and_save_config_through_injected_roots_without_tauri_app() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let roots = crate::paths::PathRoots::new(temp_dir.path(), None);

        // 首次加载写入默认配置文件。
        let loaded = super::load_config(&roots);
        assert!(roots.config_path().is_file());

        let mut updated = loaded;
        updated.theme = crate::config::types::Theme::Dark;
        super::save_config(&roots, &updated).expect("save config");

        let reloaded_json = serde_json::to_string(&super::load_config(&roots)).expect("serialize");
        let updated_json = serde_json::to_string(&updated).expect("serialize");
        assert_eq!(reloaded_json, updated_json);
    }
}
