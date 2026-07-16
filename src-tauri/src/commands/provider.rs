use crate::config;
use crate::config::types::{
    AgentKind, AppConfig, ClaudeCodeAgentConfigUpdate, CodexAgentConfigUpdate,
    NotificationSettings, Provider, Theme,
};
use crate::provider_profiles::types::{AgentProviderProfile, NativeProfileConfig, ProfileModel};
use crate::provider_profiles::{
    native_config::{render_agent_profile_config, NativeConfigContents, NativeConfigPaths},
    service::{NativeConfigWriteResult, NativeConfigWriteService},
};
use crate::AppState;
use futures::StreamExt;
use log::{debug, info};
use serde::Deserialize;
use std::{
    path::Path,
    str::FromStr,
    sync::{Mutex, MutexGuard},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};

pub const CLAUDE_DEFAULT_SUPPLIER_ID: &str = "__claude_default__";

fn acquire_profile_operation_lock(lock: &Mutex<()>) -> Result<MutexGuard<'_, ()>, String> {
    lock.lock().map_err(|_| "档案操作锁不可用".to_string())
}

fn apply_agent_config_update(
    app_config: &mut AppConfig,
    agent_kind: AgentKind,
    config: serde_json::Value,
) -> Result<(), String> {
    match agent_kind {
        AgentKind::ClaudeCode => {
            let update: ClaudeCodeAgentConfigUpdate = serde_json::from_value(config)
                .map_err(|e| format!("Invalid Claude Code config: {}", e))?;

            if let Some(executable_mode) = update.executable_mode {
                if !matches!(executable_mode.as_str(), "auto" | "bundled" | "path") {
                    return Err(format!(
                        "Unsupported Claude Code executable_mode: {}",
                        executable_mode
                    ));
                }
                app_config.agent_configs.claude_code.executable_mode = executable_mode;
            }
            if let Some(resume_sessions) = update.resume_sessions {
                app_config.agent_configs.claude_code.resume_sessions = resume_sessions;
            }
            if let Some(permission_config) = update.permission_config {
                if !matches!(
                    permission_config.permission_mode.as_str(),
                    "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"
                ) {
                    return Err(format!(
                        "Unsupported Claude Code permissionMode: {}",
                        permission_config.permission_mode
                    ));
                }
                app_config.agent_configs.claude_code.permission_config = permission_config;
            }
        }
        AgentKind::Codex => {
            let update: CodexAgentConfigUpdate = serde_json::from_value(config)
                .map_err(|e| format!("Invalid Codex config: {}", e))?;

            if let Some(sdk_mode) = update.sdk_mode {
                if !matches!(sdk_mode.as_str(), "responses" | "agent") {
                    return Err(format!("Unsupported Codex sdk_mode: {}", sdk_mode));
                }
                app_config.agent_configs.codex.sdk_mode = sdk_mode;
            }
            if let Some(permission_config) = update.permission_config {
                if !matches!(
                    permission_config.sandbox_mode.as_str(),
                    "read-only" | "workspace-write" | "danger-full-access"
                ) {
                    return Err(format!(
                        "Unsupported Codex sandboxMode: {}",
                        permission_config.sandbox_mode
                    ));
                }
                if !matches!(
                    permission_config.approval_policy.as_str(),
                    "untrusted" | "on-request" | "never"
                ) {
                    return Err(format!(
                        "Unsupported Codex approvalPolicy: {}",
                        permission_config.approval_policy
                    ));
                }
                app_config.agent_configs.codex.permission_config = permission_config;
            }
        }
        AgentKind::GeminiCli => {}
        AgentKind::Opencode => {}
    }

    Ok(())
}

fn cleanup_provider_references(config: &mut AppConfig, provider_id: &str) {
    if config.active_provider_id.as_deref() == Some(provider_id) {
        config.active_provider_id = config.providers.first().map(|p| p.id.clone());
    }
}

#[derive(Deserialize)]
pub struct AgentProviderProfileUpsert {
    id: String,
    agent_kind: AgentKind,
    name: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    models: Vec<ProfileModel>,
    default_model: String,
    native_config: NativeProfileConfigUpsert,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum NativeProfileConfigUpsert {
    ClaudeCode {
        settings: serde_json::Value,
        #[serde(default)]
        requires_review: bool,
    },
    Codex {
        #[serde(default)]
        api_key: Option<String>,
        openai_base_url: String,
        #[serde(default)]
        codex_needs_proxy: Option<bool>,
        #[serde(default)]
        advanced_config: Option<serde_json::Value>,
        #[serde(default)]
        auth_json: Option<String>,
        #[serde(default)]
        config_toml: Option<String>,
        #[serde(default)]
        model_catalog: Option<serde_json::Value>,
        #[serde(default)]
        requires_review: bool,
    },
    #[serde(rename = "opencode")]
    OpenCode {
        #[serde(default)]
        api_key: Option<String>,
        openai_base_url: String,
        #[serde(default)]
        provider_key: Option<String>,
        #[serde(default)]
        npm: Option<String>,
        #[serde(default)]
        models_config: Option<serde_json::Value>,
        #[serde(default)]
        extra_options: Option<serde_json::Value>,
        #[serde(default)]
        advanced_config: Option<serde_json::Value>,
        #[serde(default)]
        requires_review: bool,
    },
}

impl AgentProviderProfileUpsert {
    fn into_profile(
        self,
        existing: Option<&AgentProviderProfile>,
    ) -> Result<AgentProviderProfile, String> {
        if existing.is_some_and(|profile| profile.agent_kind != self.agent_kind) {
            return Err("同一档案 ID 不允许更改智能体类型".to_string());
        }

        let native_config = match (self.agent_kind, self.native_config) {
            (
                AgentKind::ClaudeCode,
                NativeProfileConfigUpsert::ClaudeCode {
                    settings,
                    requires_review,
                },
            ) => NativeProfileConfig::ClaudeCode {
                settings,
                requires_review,
            },
            (
                AgentKind::Codex,
                NativeProfileConfigUpsert::Codex {
                    api_key,
                    openai_base_url,
                    codex_needs_proxy,
                    advanced_config,
                    auth_json,
                    config_toml,
                    model_catalog,
                    requires_review,
                },
            ) => {
                let (prev_api_key, prev_advanced, prev_auth_json, prev_config_toml) = match existing
                    .and_then(|profile| match &profile.native_config {
                        NativeProfileConfig::Codex {
                            api_key,
                            advanced_config,
                            auth_json,
                            config_toml,
                            ..
                        } => Some((
                            api_key.as_str(),
                            advanced_config.clone(),
                            auth_json.clone(),
                            config_toml.clone(),
                        )),
                        _ => None,
                    }) {
                    Some((a, b, c, d)) => (Some(a), b, c, d),
                    None => (None, None, None, None),
                };
                NativeProfileConfig::Codex {
                    api_key: resolve_api_key(prev_api_key, api_key)?,
                    openai_base_url,
                    codex_needs_proxy,
                    advanced_config: resolve_advanced_config(prev_advanced, advanced_config)?,
                    auth_json: auth_json.or(prev_auth_json),
                    config_toml: config_toml.or(prev_config_toml),
                    model_catalog: model_catalog.map(|v| v.to_string()),
                    requires_review,
                }
            }
            (
                AgentKind::Opencode,
                NativeProfileConfigUpsert::OpenCode {
                    api_key,
                    openai_base_url,
                    provider_key,
                    npm,
                    models_config,
                    extra_options,
                    advanced_config,
                    requires_review,
                },
            ) => {
                let previous = existing.and_then(|profile| match &profile.native_config {
                    NativeProfileConfig::OpenCode {
                        api_key,
                        advanced_config,
                        ..
                    } => Some((api_key.as_str(), advanced_config.clone())),
                    _ => None,
                });
                NativeProfileConfig::OpenCode {
                    api_key: resolve_api_key(
                        previous.as_ref().map(|(api_key, _)| *api_key),
                        api_key,
                    )?,
                    openai_base_url,
                    provider_key,
                    npm,
                    models_config,
                    extra_options,
                    advanced_config: resolve_advanced_config(
                        previous.and_then(|(_, advanced_config)| advanced_config),
                        advanced_config,
                    )?,
                    requires_review,
                }
            }
            _ => return Err("档案智能体类型与原生配置类型不一致".to_string()),
        };

        Ok(AgentProviderProfile {
            id: self.id,
            agent_kind: self.agent_kind,
            name: self.name,
            note: self.note,
            models: self.models,
            default_model: self.default_model,
            native_config,
        })
    }
}

fn resolve_api_key(existing: Option<&str>, incoming: Option<String>) -> Result<String, String> {
    Ok(incoming
        .filter(|api_key| !api_key.is_empty())
        .or_else(|| existing.map(ToOwned::to_owned))
        .unwrap_or_default())
}

fn resolve_advanced_config(
    existing: Option<serde_json::Value>,
    incoming: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(incoming.or(existing))
}

fn upsert_agent_profile_in_config(
    app_config: &mut AppConfig,
    profile: AgentProviderProfile,
) -> Result<(), String> {
    profile.validate()?;

    let mut registry = app_config.agent_profile_registry.clone();
    if let Some(existing) = registry
        .profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        if existing.agent_kind != profile.agent_kind {
            return Err("同一档案 ID 不允许更改智能体类型".to_string());
        }
        *existing = profile;
    } else {
        registry.profiles.push(profile);
    }

    registry.validate()?;
    app_config.agent_profile_registry = registry;
    app_config.profile_registry_is_derived = false;
    app_config.profile_registry_validation_error = None;
    Ok(())
}

fn redact_config_for_frontend(app_config: &AppConfig) -> AppConfig {
    let mut redacted = app_config.clone();
    for provider in &mut redacted.providers {
        provider.api_key.clear();
    }
    for profile in &mut redacted.agent_profile_registry.profiles {
        match &mut profile.native_config {
            NativeProfileConfig::ClaudeCode { .. } => {}
            NativeProfileConfig::Codex {
                advanced_config, ..
            }
            | NativeProfileConfig::OpenCode {
                advanced_config, ..
            } => {
                *advanced_config = None;
            }
        }
    }
    redacted
}

fn set_active_profile_in_config(
    app_config: &mut AppConfig,
    agent_kind: AgentKind,
    profile_id: &str,
) -> Result<(), String> {
    let profile = app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.agent_kind == agent_kind)
        .ok_or_else(|| "档案不存在或不属于当前智能体".to_string())?;
    if profile
        .models
        .iter()
        .all(|model| model.id.trim().is_empty())
    {
        return Err("请先为档案配置至少一个模型".to_string());
    }

    app_config
        .agent_profile_registry
        .active_profile_ids
        .insert(agent_kind, profile_id.to_string());
    app_config.profile_registry_is_derived = false;
    app_config.profile_registry_validation_error = None;
    Ok(())
}

fn set_active_profile_default_model_in_config(
    app_config: &mut AppConfig,
    agent_kind: AgentKind,
    default_model: &str,
) -> Result<(), String> {
    let default_model = default_model.trim();

    let active_profile_id = app_config
        .agent_profile_registry
        .active_profile_ids
        .get(&agent_kind)
        .ok_or("当前智能体没有启用档案")?
        .clone();
    let profile = app_config
        .agent_profile_registry
        .profiles
        .iter_mut()
        .find(|profile| profile.id == active_profile_id && profile.agent_kind == agent_kind)
        .ok_or("档案不存在或不属于当前智能体")?;
    if default_model.is_empty() {
        profile.default_model.clear();
    } else if !profile.models.iter().any(|model| model.id == default_model) {
        return Err("默认模型必须属于当前启用档案的模型列表".to_string());
    } else {
        profile.default_model = default_model.to_string();
    }
    app_config.profile_registry_is_derived = false;
    app_config.profile_registry_validation_error = None;
    Ok(())
}

fn commit_profile_config_after_native_write<C, R, S>(
    app_config: &mut AppConfig,
    updated_config: AppConfig,
    compensation: C,
    compensate_native: R,
    save_config: S,
) -> Result<C, String>
where
    R: FnOnce(&C) -> Result<(), String>,
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    if let Err(save_error) = save_config(&updated_config) {
        return match compensate_native(&compensation) {
            Ok(()) => Err(save_error),
            Err(compensation_error) => Err(format!(
                "保存应用配置失败: {save_error}；原生配置补偿恢复失败: {compensation_error}。请保留恢复记录并稍后重试"
            )),
        };
    }
    *app_config = updated_config;
    Ok(compensation)
}

fn activate_agent_profile_transaction<W, C, R, S>(
    app_config: &mut AppConfig,
    agent_kind: AgentKind,
    profile_id: &str,
    write_native: W,
    compensate_native: R,
    save_config: S,
) -> Result<C, String>
where
    W: FnOnce(&AgentProviderProfile) -> Result<C, String>,
    R: FnOnce(&C) -> Result<(), String>,
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    let mut updated_config = app_config.clone();
    set_active_profile_in_config(&mut updated_config, agent_kind, profile_id)?;
    let profile = agent_profile_from_config(&updated_config, agent_kind, profile_id)?;
    let compensation = write_native(&profile)?;
    commit_profile_config_after_native_write(
        app_config,
        updated_config,
        compensation,
        compensate_native,
        save_config,
    )
}

fn set_active_profile_model_transaction<W, C, R, S>(
    app_config: &mut AppConfig,
    agent_kind: AgentKind,
    default_model: &str,
    write_native: W,
    compensate_native: R,
    save_config: S,
) -> Result<C, String>
where
    W: FnOnce(&AgentProviderProfile) -> Result<C, String>,
    R: FnOnce(&C) -> Result<(), String>,
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    let mut updated_config = app_config.clone();
    set_active_profile_default_model_in_config(&mut updated_config, agent_kind, default_model)?;
    let updated_profile = active_agent_profile_from_config(&updated_config, agent_kind)?;
    let compensation = write_native(&updated_profile)?;
    commit_profile_config_after_native_write(
        app_config,
        updated_config,
        compensation,
        compensate_native,
        save_config,
    )
}

fn save_profile_config_candidate<S>(
    app_config: &mut AppConfig,
    updated_config: AppConfig,
    save_config: S,
) -> Result<(), String>
where
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    save_config(&updated_config)?;
    *app_config = updated_config;
    Ok(())
}

fn upsert_agent_profile_transaction<W, C, R, S>(
    app_config: &mut AppConfig,
    profile: AgentProviderProfile,
    write_native: W,
    compensate_native: R,
    save_config: S,
) -> Result<Option<C>, String>
where
    W: FnOnce(&AgentProviderProfile) -> Result<C, String>,
    R: FnOnce(&C) -> Result<(), String>,
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    let profile_id = profile.id.clone();
    let agent_kind = profile.agent_kind;
    let mut updated_config = app_config.clone();
    upsert_agent_profile_in_config(&mut updated_config, profile)?;
    let is_active = updated_config
        .agent_profile_registry
        .active_profile_ids
        .get(&agent_kind)
        .is_some_and(|active_profile_id| active_profile_id == &profile_id);
    if !is_active {
        save_profile_config_candidate(app_config, updated_config, save_config)?;
        return Ok(None);
    }

    let updated_profile = agent_profile_from_config(&updated_config, agent_kind, &profile_id)?;
    let compensation = write_native(&updated_profile)?;
    commit_profile_config_after_native_write(
        app_config,
        updated_config,
        compensation,
        compensate_native,
        save_config,
    )
    .map(Some)
}

fn delete_agent_profile_transaction<W, C, R, S>(
    app_config: &mut AppConfig,
    profile_id: &str,
    write_native: W,
    compensate_native: R,
    save_config: S,
) -> Result<Option<C>, String>
where
    W: FnOnce(&AgentProviderProfile) -> Result<C, String>,
    R: FnOnce(&C) -> Result<(), String>,
    S: FnOnce(&AppConfig) -> Result<(), String>,
{
    let deleted_profile = app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or("档案不存在")?;
    let is_active = app_config
        .agent_profile_registry
        .active_profile_ids
        .get(&deleted_profile.agent_kind)
        .is_some_and(|active_profile_id| active_profile_id == profile_id);
    let mut updated_config = app_config.clone();
    delete_agent_profile_from_config(&mut updated_config, profile_id)?;
    if !is_active {
        save_profile_config_candidate(app_config, updated_config, save_config)?;
        return Ok(None);
    }

    let compensation = write_native(&deleted_profile)?;
    commit_profile_config_after_native_write(
        app_config,
        updated_config,
        compensation,
        compensate_native,
        save_config,
    )
    .map(Some)
}

fn delete_agent_profile_from_config(
    app_config: &mut AppConfig,
    profile_id: &str,
) -> Result<(), String> {
    let profile_index = app_config
        .agent_profile_registry
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id)
        .ok_or("档案不存在")?;
    let profile = app_config
        .agent_profile_registry
        .profiles
        .remove(profile_index);

    if app_config
        .agent_profile_registry
        .active_profile_ids
        .get(&profile.agent_kind)
        .is_some_and(|active_profile_id| active_profile_id == profile_id)
    {
        app_config
            .agent_profile_registry
            .active_profile_ids
            .remove(&profile.agent_kind);
    }
    app_config.profile_registry_is_derived = false;
    app_config.profile_registry_validation_error = None;
    Ok(())
}

fn profile_models_from_config(
    app_config: &AppConfig,
    agent_kind: AgentKind,
    profile_id: &str,
) -> Result<Vec<ProfileModel>, String> {
    app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.agent_kind == agent_kind)
        .map(|profile| profile.models.clone())
        .ok_or_else(|| "档案不存在或不属于当前智能体".to_string())
}

fn agent_profile_from_config(
    app_config: &AppConfig,
    agent_kind: AgentKind,
    profile_id: &str,
) -> Result<AgentProviderProfile, String> {
    app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.agent_kind == agent_kind)
        .cloned()
        .ok_or_else(|| "档案不存在或不属于当前智能体".to_string())
}

fn active_agent_profile_from_config(
    app_config: &AppConfig,
    agent_kind: AgentKind,
) -> Result<AgentProviderProfile, String> {
    let profile_id = app_config
        .agent_profile_registry
        .active_profile_ids
        .get(&agent_kind)
        .ok_or("当前智能体没有启用档案")?;
    agent_profile_from_config(app_config, agent_kind, profile_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileApiProtocol {
    Anthropic,
    OpenAiCompatible,
}

struct ProfileApiConnection<'a> {
    protocol: ProfileApiProtocol,
    api_key: &'a str,
    base_url: &'a str,
}

fn profile_api_connection(
    profile: &AgentProviderProfile,
) -> Result<ProfileApiConnection<'_>, String> {
    profile.validate()?;

    let connection = match &profile.native_config {
        NativeProfileConfig::ClaudeCode { .. } => ProfileApiConnection {
            protocol: ProfileApiProtocol::Anthropic,
            api_key: profile
                .native_config
                .claude_env_value("ANTHROPIC_AUTH_TOKEN")
                .unwrap_or_default(),
            base_url: profile
                .native_config
                .claude_env_value("ANTHROPIC_BASE_URL")
                .unwrap_or_default(),
        },
        NativeProfileConfig::Codex {
            api_key,
            openai_base_url,
            ..
        }
        | NativeProfileConfig::OpenCode {
            api_key,
            openai_base_url,
            ..
        } => ProfileApiConnection {
            protocol: ProfileApiProtocol::OpenAiCompatible,
            api_key,
            base_url: openai_base_url,
        },
    };

    if connection.api_key.trim().is_empty() || connection.base_url.trim().is_empty() {
        return Err("请配置 Base URL 和 API Key".to_string());
    }
    Ok(connection)
}

fn redact_profile_error(error: &str, profile: &AgentProviderProfile) -> String {
    let api_key = match &profile.native_config {
        NativeProfileConfig::ClaudeCode { .. } => profile
            .native_config
            .claude_env_value("ANTHROPIC_AUTH_TOKEN")
            .unwrap_or_default(),
        NativeProfileConfig::Codex { api_key, .. }
        | NativeProfileConfig::OpenCode { api_key, .. } => api_key,
    };
    if api_key.is_empty() {
        error.to_string()
    } else {
        error.replace(api_key, "[已脱敏]")
    }
}

fn native_config_paths(app: &AppHandle) -> Result<NativeConfigPaths, String> {
    let path_resolver = app.path();
    let resolve_home_path = |path: &str| {
        path_resolver
            .resolve(path, BaseDirectory::Home)
            .map_err(|_| "无法解析智能体原生配置目录".to_string())
    };

    Ok(NativeConfigPaths::new(
        resolve_home_path(".claude")?,
        resolve_home_path(".codex")?,
        resolve_home_path(".config/opencode")?,
    ))
}

fn read_optional_native_config(path: &Path, label: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("无法读取 {}，请检查文件权限", label)),
    }
}

fn read_native_config_contents(paths: &NativeConfigPaths) -> Result<NativeConfigContents, String> {
    Ok(NativeConfigContents {
        claude_settings: read_optional_native_config(
            &paths.claude_settings_path(),
            "Claude Code settings.json",
        )?,
        codex_auth: read_optional_native_config(&paths.codex_auth_path(), "Codex auth.json")?,
        codex_config: read_optional_native_config(&paths.codex_config_path(), "Codex config.toml")?,
        opencode_config: read_optional_native_config(
            &paths.opencode_config_path(),
            "OpenCode opencode.json",
        )?,
    })
}

fn apply_native_profile_config(
    paths: &NativeConfigPaths,
    backup_root: std::path::PathBuf,
    profile: &AgentProviderProfile,
) -> Result<NativeConfigWriteResult, String> {
    profile.validate()?;
    let contents = read_native_config_contents(paths)?;
    let rendered_files = render_agent_profile_config(paths, profile, &contents)?;
    let result = NativeConfigWriteService::new(paths.clone(), backup_root)
        .write(&rendered_files)
        .map_err(|error| {
            debug!(
                target: "provider",
                "Native profile configuration write failed category={} target={:?} rollback={:?} backup_session_dir={:?}",
                error.failure_category,
                error.target_identifier,
                error.rollback_status,
                error.backup_session_dir,
            );
            format!("原生配置写入失败: {}", error)
        })?;
    debug!(
        target: "provider",
        "Native profile configuration written backup_session_dir={}",
        result.backup_session_dir.display()
    );
    Ok(result)
}

fn apply_native_profile_config_for_app(
    state: &AppState,
    app: &AppHandle,
    profile: &AgentProviderProfile,
) -> Result<NativeConfigWriteResult, String> {
    let paths = native_config_paths(app)?;
    apply_native_profile_config(
        &paths,
        state.app_data_dir.join("provider-profile-backups"),
        profile,
    )
    .map_err(|error| redact_profile_error(&error, profile))
}

fn restore_native_profile_config_for_app(
    state: &AppState,
    app: &AppHandle,
    profile: &AgentProviderProfile,
    compensation: &NativeConfigWriteResult,
) -> Result<(), String> {
    let paths = native_config_paths(app)?;
    NativeConfigWriteService::new(
        paths,
        state.app_data_dir.join("provider-profile-backups"),
    )
    .restore_from_backup_session(&compensation.backup_session_dir)
    .map_err(|error| {
        debug!(
            target: "provider",
            "Native profile configuration compensation failed category={} target={:?} rollback={:?} backup_session_dir={}",
            error.failure_category,
            error.target_identifier,
            error.rollback_status,
            compensation.backup_session_dir.display()
        );
        redact_profile_error(&format!("原生配置恢复失败: {}", error), profile)
    })
}

fn discard_native_profile_backup_after_success(
    state: &AppState,
    app: &AppHandle,
    compensation: &NativeConfigWriteResult,
) {
    let Ok(paths) = native_config_paths(app) else {
        debug!(
            target: "provider",
            "Native profile backup cleanup skipped because configuration paths could not be resolved"
        );
        return;
    };
    if let Err(error) =
        NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
            .discard_committed_backup_session(&compensation.backup_session_dir)
    {
        debug!(
            target: "provider",
            "Native profile backup cleanup failed category={} rollback={:?}",
            error.failure_category,
            error.rollback_status,
        );
    }
}

#[tauri::command]
pub fn upsert_agent_provider_profile(
    state: State<'_, AppState>,
    app: AppHandle,
    profile: AgentProviderProfileUpsert,
) -> Result<(), String> {
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    let mut app_config = state.config.lock().unwrap();
    let existing = app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|existing| existing.id == profile.id);
    let profile = profile.into_profile(existing)?;
    profile.validate()?;
    info!(
        target: "provider",
        "Upserting agent provider profile profile_id={} agent_kind={}",
        profile.id,
        profile.agent_kind.as_str()
    );

    let profile_for_redaction = profile.clone();
    if profile.agent_kind == AgentKind::ClaudeCode {
        let mut updated_config = app_config.clone();
        upsert_agent_profile_in_config(&mut updated_config, profile.clone())
            .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
        config::save_config(&app, &updated_config)
            .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
        *app_config = updated_config;

        let is_active = app_config
            .agent_profile_registry
            .active_profile_ids
            .get(&AgentKind::ClaudeCode)
            .map(|id| id == &profile_for_redaction.id)
            .unwrap_or(false);
        if is_active {
            let compensation =
                apply_native_profile_config_for_app(state.inner(), &app, &profile_for_redaction)
                    .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
            discard_native_profile_backup_after_success(state.inner(), &app, &compensation);
        }

        return Ok(());
    }
    let compensation = upsert_agent_profile_transaction(
        &mut app_config,
        profile,
        |updated_profile| apply_native_profile_config_for_app(state.inner(), &app, updated_profile),
        |compensation| {
            restore_native_profile_config_for_app(
                state.inner(),
                &app,
                &profile_for_redaction,
                compensation,
            )
        },
        |config| config::save_config(&app, config),
    )
    .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
    if let Some(compensation) = compensation {
        discard_native_profile_backup_after_success(state.inner(), &app, &compensation);
    }
    Ok(())
}

#[tauri::command]
pub fn activate_agent_provider_profile(
    state: State<'_, AppState>,
    app: AppHandle,
    agent_kind: String,
    profile_id: String,
) -> Result<(), String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    info!(
        target: "provider",
        "Activating agent provider profile profile_id={} agent_kind={}",
        profile_id,
        agent_kind.as_str()
    );
    let mut app_config = state.config.lock().unwrap();
    if profile_id == CLAUDE_DEFAULT_SUPPLIER_ID {
        return Err("默认供应商必须通过专用切换命令激活".to_string());
    }
    let profile_for_redaction = agent_profile_from_config(&app_config, agent_kind, &profile_id)?;
    if agent_kind == AgentKind::ClaudeCode
        && !app_config
            .agent_profile_registry
            .active_profile_ids
            .contains_key(&AgentKind::ClaudeCode)
    {
        let paths = native_config_paths(&app)?;
        NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
            .backup_claude_settings()
            .map_err(|error| format!("无法备份默认 Claude Code 配置: {error}"))?;
    }
    if agent_kind == AgentKind::Codex
        && !app_config
            .agent_profile_registry
            .active_profile_ids
            .contains_key(&AgentKind::Codex)
    {
        let paths = native_config_paths(&app)?;
        NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
            .backup_codex_files()
            .map_err(|error| format!("无法备份默认 Codex 配置: {error}"))?;
    }
    if agent_kind == AgentKind::Opencode
        && !app_config
            .agent_profile_registry
            .active_profile_ids
            .contains_key(&AgentKind::Opencode)
    {
        let paths = native_config_paths(&app)?;
        NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
            .backup_opencode_config()
            .map_err(|error| format!("无法备份默认 OpenCode 配置: {error}"))?;
    }
    let compensation = activate_agent_profile_transaction(
        &mut app_config,
        agent_kind,
        &profile_id,
        |profile| apply_native_profile_config_for_app(state.inner(), &app, profile),
        |compensation| {
            restore_native_profile_config_for_app(
                state.inner(),
                &app,
                &profile_for_redaction,
                compensation,
            )
        },
        |config| config::save_config(&app, config),
    )
    .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
    discard_native_profile_backup_after_success(state.inner(), &app, &compensation);
    Ok(())
}

#[tauri::command]
pub fn activate_default_claude_supplier(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    let mut app_config = state.config.lock().unwrap();
    if !app_config
        .agent_profile_registry
        .active_profile_ids
        .contains_key(&AgentKind::ClaudeCode)
    {
        return Ok(());
    }
    let paths = native_config_paths(&app)?;
    NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
        .restore_claude_settings_backup()
        .map_err(|error| format!("无法恢复默认 Claude Code 配置: {error}"))?;

    let mut updated_config = app_config.clone();
    updated_config
        .agent_profile_registry
        .active_profile_ids
        .remove(&AgentKind::ClaudeCode);
    config::save_config(&app, &updated_config)?;
    *app_config = updated_config;
    Ok(())
}

#[tauri::command]
pub fn activate_default_codex_supplier(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    let mut app_config = state.config.lock().unwrap();
    if !app_config
        .agent_profile_registry
        .active_profile_ids
        .contains_key(&AgentKind::Codex)
    {
        return Ok(());
    }
    let paths = native_config_paths(&app)?;
    NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
        .restore_codex_files_backup()
        .map_err(|error| format!("无法恢复默认 Codex 配置: {error}"))?;

    let mut updated_config = app_config.clone();
    updated_config
        .agent_profile_registry
        .active_profile_ids
        .remove(&AgentKind::Codex);
    config::save_config(&app, &updated_config)?;
    *app_config = updated_config;
    Ok(())
}

#[tauri::command]
pub fn activate_default_opencode_supplier(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    let mut app_config = state.config.lock().unwrap();
    if !app_config
        .agent_profile_registry
        .active_profile_ids
        .contains_key(&AgentKind::Opencode)
    {
        return Ok(());
    }
    let paths = native_config_paths(&app)?;
    NativeConfigWriteService::new(paths, state.app_data_dir.join("provider-profile-backups"))
        .restore_opencode_config_backup()
        .map_err(|error| format!("无法恢复默认 OpenCode 配置: {error}"))?;

    let mut updated_config = app_config.clone();
    updated_config
        .agent_profile_registry
        .active_profile_ids
        .remove(&AgentKind::Opencode);
    config::save_config(&app, &updated_config)?;
    *app_config = updated_config;
    Ok(())
}

#[tauri::command]
pub fn set_active_agent_profile_model(
    state: State<'_, AppState>,
    app: AppHandle,
    agent_kind: String,
    default_model: String,
) -> Result<(), String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    info!(
        target: "provider",
        "Setting active agent profile model agent_kind={} model={}",
        agent_kind.as_str(),
        default_model
    );
    let mut app_config = state.config.lock().unwrap();
    let profile_for_redaction = active_agent_profile_from_config(&app_config, agent_kind)?;
    let compensation = set_active_profile_model_transaction(
        &mut app_config,
        agent_kind,
        &default_model,
        |profile| apply_native_profile_config_for_app(state.inner(), &app, profile),
        |compensation| {
            restore_native_profile_config_for_app(
                state.inner(),
                &app,
                &profile_for_redaction,
                compensation,
            )
        },
        |config| config::save_config(&app, config),
    )
    .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
    discard_native_profile_backup_after_success(state.inner(), &app, &compensation);
    Ok(())
}

#[tauri::command]
pub fn delete_agent_provider_profile(
    state: State<'_, AppState>,
    app: AppHandle,
    profile_id: String,
) -> Result<(), String> {
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    info!(target: "provider", "Deleting agent provider profile profile_id={}", profile_id);
    let mut app_config = state.config.lock().unwrap();
    let profile_for_redaction = app_config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or("档案不存在")?;
    let compensation = delete_agent_profile_transaction(
        &mut app_config,
        &profile_id,
        |deleted_profile| apply_native_profile_config_for_app(state.inner(), &app, deleted_profile),
        |compensation| {
            restore_native_profile_config_for_app(
                state.inner(),
                &app,
                &profile_for_redaction,
                compensation,
            )
        },
        |config| config::save_config(&app, config),
    )
    .map_err(|error| redact_profile_error(&error, &profile_for_redaction))?;
    if let Some(compensation) = compensation {
        discard_native_profile_backup_after_success(state.inner(), &app, &compensation);
    }
    Ok(())
}

#[tauri::command]
pub fn fetch_agent_profile_models(
    state: State<'_, AppState>,
    agent_kind: String,
    profile_id: String,
) -> Result<Vec<ProfileModel>, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let _operation_lock = acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
    info!(
        target: "provider",
        "Fetching agent profile models profile_id={} agent_kind={}",
        profile_id,
        agent_kind.as_str()
    );
    let app_config = state.config.lock().unwrap();
    profile_models_from_config(&app_config, agent_kind, &profile_id)
}

#[tauri::command]
pub async fn test_agent_provider_profile(
    state: State<'_, AppState>,
    agent_kind: String,
    profile_id: String,
) -> Result<String, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    info!(
        target: "provider",
        "Testing agent provider profile profile_id={} agent_kind={}",
        profile_id,
        agent_kind.as_str()
    );
    let profile = {
        let _operation_lock =
            acquire_profile_operation_lock(&state.provider_profile_operation_lock)?;
        let app_config = state.config.lock().unwrap();
        agent_profile_from_config(&app_config, agent_kind, &profile_id)?
    };
    let connection =
        profile_api_connection(&profile).map_err(|error| redact_profile_error(&error, &profile))?;
    let model = profile
        .models
        .iter()
        .map(|model| model.id.trim())
        .find(|model| !model.is_empty())
        .ok_or_else(|| "请先配置至少一个模型".to_string())?;

    let result = match connection.protocol {
        ProfileApiProtocol::Anthropic => {
            test_anthropic_stream(connection.base_url, connection.api_key, model)
                .await
                .map(|_| model.to_string())
        }
        ProfileApiProtocol::OpenAiCompatible => {
            test_openai_stream(connection.base_url, connection.api_key, model)
                .await
                .map(|_| model.to_string())
        }
    };
    result.map_err(|error| redact_profile_error(&error, &profile))
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    debug!(target: "provider", "Loading app config");
    redact_config_for_frontend(&state.config.lock().unwrap())
}

#[tauri::command]
pub fn update_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider: Provider,
) -> Result<(), String> {
    info!(target: "provider", "Upserting provider provider_id={} name={}", provider.id, provider.name);
    let mut config = state.config.lock().unwrap();

    if let Some(existing) = config.providers.iter_mut().find(|p| p.id == provider.id) {
        *existing = provider;
    } else {
        config.providers.push(provider);
    }

    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn delete_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    info!(target: "provider", "Deleting provider provider_id={}", provider_id);
    let mut config = state.config.lock().unwrap();
    config.providers.retain(|p| p.id != provider_id);
    cleanup_provider_references(&mut config, &provider_id);

    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_active_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    info!(target: "provider", "Setting active provider provider_id={}", provider_id);
    let mut config = state.config.lock().unwrap();
    config.active_provider_id = Some(provider_id);
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_default_agent_kind(
    state: State<'_, AppState>,
    app: AppHandle,
    agent_kind: String,
) -> Result<(), String> {
    info!(target: "provider", "Setting default agent kind agent_kind={}", agent_kind);
    let mut config = state.config.lock().unwrap();
    config.agent_defaults.default_agent_kind = AgentKind::from_str(&agent_kind)?;
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn update_agent_config(
    state: State<'_, AppState>,
    app: AppHandle,
    agent_kind: String,
    config: serde_json::Value,
) -> Result<(), String> {
    info!(target: "provider", "Updating agent config agent_kind={}", agent_kind);
    let mut app_config = state.config.lock().unwrap();
    apply_agent_config_update(&mut app_config, AgentKind::from_str(&agent_kind)?, config)?;

    config::save_config(&app, &app_config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_profile_operation_lock, activate_agent_profile_transaction,
        apply_agent_config_update, apply_native_profile_config, cleanup_provider_references,
        delete_agent_profile_from_config, delete_agent_profile_transaction, profile_api_connection,
        profile_models_from_config, redact_config_for_frontend, redact_profile_error,
        set_active_profile_default_model_in_config, set_active_profile_in_config,
        set_active_profile_model_transaction, upsert_agent_profile_in_config,
        upsert_agent_profile_transaction, AgentProviderProfileUpsert, ProfileApiProtocol,
    };
    use crate::config::types::{AgentKind, AppConfig, Provider};
    use crate::provider_profiles::native_config::NativeConfigPaths;
    use crate::provider_profiles::types::{
        AgentProviderProfile, NativeProfileConfig, ProfileModel,
    };
    use std::{sync::mpsc, sync::Arc, sync::Mutex, thread, time::Duration};

    fn codex_profile(id: &str, default_model: &str) -> AgentProviderProfile {
        AgentProviderProfile {
            id: id.to_string(),
            agent_kind: AgentKind::Codex,
            name: "测试 Codex 档案".to_string(),
            note: String::new(),
            models: vec![ProfileModel {
                id: default_model.to_string(),
                name: None,
                context_window: None,
            }],
            default_model: default_model.to_string(),
            native_config: NativeProfileConfig::Codex {
                api_key: "test-key".to_string(),
                openai_base_url: "https://api.example.test/v1".to_string(),
                codex_needs_proxy: None,
                advanced_config: None,
                auth_json: None,
                config_toml: None,
                model_catalog: None,
                requires_review: false,
            },
        }
    }

    #[test]
    fn 档案操作锁会串行化并发操作() {
        let operation_lock = Arc::new(Mutex::new(()));
        let first_operation = acquire_profile_operation_lock(&operation_lock).unwrap();
        let (sender, receiver) = mpsc::channel();
        let second_lock = Arc::clone(&operation_lock);
        let second_operation = thread::spawn(move || {
            let _guard = acquire_profile_operation_lock(&second_lock).unwrap();
            sender.send(()).unwrap();
        });

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first_operation);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        second_operation.join().unwrap();
    }

    #[test]
    fn upserting_agent_profile_replaces_existing_profile() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();

        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-b")).unwrap();

        assert_eq!(app_config.agent_profile_registry.profiles.len(), 1);
        assert_eq!(
            app_config.agent_profile_registry.profiles[0].default_model,
            "model-b"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn 档案更新DTO区分保留与清除机密字段() {
        let mut existing = codex_profile("codex", "model-a");
        if let NativeProfileConfig::Codex {
            advanced_config, ..
        } = &mut existing.native_config
        {
            *advanced_config = Some(serde_json::json!({ "auth": { "token": "secret" } }));
        }
        let base = serde_json::json!({
            "id": "codex",
            "agent_kind": "codex",
            "name": "测试 Codex 档案",
            "models": [{ "id": "model-a" }],
            "default_model": "model-a",
            "native_config": {
                "type": "codex",
                "openai_base_url": "https://api.example.test/v1"
            }
        });

        let omitted: AgentProviderProfileUpsert = serde_json::from_value(base.clone()).unwrap();
        let omitted = omitted.into_profile(Some(&existing)).unwrap();
        let mut redacted_value = base;
        redacted_value["native_config"] = serde_json::json!({
            "type": "codex",
            "api_key": "",
            "advanced_config": null,
            "openai_base_url": "https://api.example.test/v1"
        });
        let redacted: AgentProviderProfileUpsert = serde_json::from_value(redacted_value).unwrap();
        let redacted = redacted.into_profile(Some(&existing)).unwrap();

        for profile in [omitted, redacted] {
            let NativeProfileConfig::Codex {
                api_key,
                advanced_config,
                ..
            } = profile.native_config
            else {
                panic!("应为 Codex 档案");
            };
            assert_eq!(api_key, "test-key");
            assert_eq!(
                advanced_config,
                Some(serde_json::json!({ "auth": { "token": "secret" } }))
            );
        }
    }

    #[test]
    fn get_config_view_redacts_profile_secrets_and_advanced_config() {
        let mut app_config = AppConfig::default();
        app_config.providers.push(Provider {
            id: "legacy".to_string(),
            name: "Legacy".to_string(),
            api_key: "legacy-secret".to_string(),
            anthropic_base_url: String::new(),
            openai_base_url: String::new(),
            default_model: String::new(),
            models: Vec::new(),
            context_1m: None,
            codex_needs_proxy: None,
        });
        let mut profile = codex_profile("codex", "model-a");
        if let NativeProfileConfig::Codex {
            api_key,
            advanced_config,
            ..
        } = &mut profile.native_config
        {
            *api_key = "secret-key".to_string();
            *advanced_config = Some(serde_json::json!({ "auth": { "token": "secret" } }));
        }
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();

        let view = redact_config_for_frontend(&app_config);
        let NativeProfileConfig::Codex {
            api_key,
            advanced_config,
            ..
        } = &view.agent_profile_registry.profiles[0].native_config
        else {
            panic!("应为 Codex 档案");
        };

        assert_eq!(api_key, "secret-key");
        assert!(advanced_config.is_none());
        assert!(view
            .providers
            .iter()
            .find(|provider| provider.id == "legacy")
            .unwrap()
            .api_key
            .is_empty());
    }

    #[test]
    fn get_config_view保留_claude_settings_中的认证令牌但继续脱敏其他档案() {
        let mut app_config = AppConfig::default();
        let claude: AgentProviderProfile = serde_json::from_value(serde_json::json!({
            "id": "claude",
            "agent_kind": "claude_code",
            "name": "Claude",
            "models": [{ "id": "claude-model" }],
            "default_model": "claude-model",
            "native_config": {
                "type": "claude_code",
                "api_key": "claude-secret",
                "anthropic_base_url": "https://claude.example.test"
            }
        }))
        .unwrap();
        upsert_agent_profile_in_config(&mut app_config, claude).unwrap();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();

        let view = redact_config_for_frontend(&app_config);
        let claude = view
            .agent_profile_registry
            .profiles
            .iter()
            .find(|profile| profile.id == "claude")
            .unwrap();
        let claude_config = serde_json::to_value(&claude.native_config).unwrap();
        let codex = view
            .agent_profile_registry
            .profiles
            .iter()
            .find(|profile| profile.id == "codex")
            .unwrap();

        assert_eq!(
            claude_config["settings"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            "claude-secret"
        );
        let NativeProfileConfig::Codex {
            api_key,
            advanced_config,
            ..
        } = &codex.native_config
        else {
            panic!("应为 Codex 档案");
        };
        assert_eq!(api_key, "test-key");
        assert!(advanced_config.is_none());
    }

    #[test]
    fn profile_validation_rejects_default_model_not_in_models() {
        let mut profile = codex_profile("codex", "model-a");
        profile.default_model = "model-b".to_string();

        let error = profile.validate().unwrap_err();

        assert_eq!(error, "默认模型必须属于档案的模型列表");
    }

    #[test]
    fn profile_validation_allows_empty_default_model_with_models() {
        let mut profile = codex_profile("codex", "model-a");
        profile.default_model.clear();

        assert!(profile.validate().is_ok());
    }

    #[test]
    fn upserting_existing_profile_rejects_agent_kind_change_without_mutation() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("shared", "model-a"))
            .unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let profile = AgentProviderProfile {
            id: "shared".to_string(),
            agent_kind: AgentKind::ClaudeCode,
            name: "Claude 档案".to_string(),
            note: String::new(),
            models: vec![ProfileModel {
                id: "claude-model".to_string(),
                name: None,
                context_window: None,
            }],
            default_model: "claude-model".to_string(),
            native_config: NativeProfileConfig::ClaudeCode {
                settings: serde_json::json!({ "env": {
                    "ANTHROPIC_AUTH_TOKEN": "test-key",
                    "ANTHROPIC_BASE_URL": "https://api.example.test"
                }}),
                requires_review: false,
            },
        };

        let error = upsert_agent_profile_in_config(&mut app_config, profile).unwrap_err();

        assert_eq!(error, "同一档案 ID 不允许更改智能体类型");
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn activating_profile_rejects_profile_for_another_agent() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();

        let error = set_active_profile_in_config(&mut app_config, AgentKind::ClaudeCode, "codex")
            .unwrap_err();

        assert_eq!(error, "档案不存在或不属于当前智能体");
        assert!(app_config
            .agent_profile_registry
            .active_profile_ids
            .is_empty());
    }

    #[test]
    fn 空默认模型档案不可激活() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("empty-model", "model-a");
        profile.models.clear();
        profile.default_model.clear();
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();

        let error = set_active_profile_in_config(&mut app_config, AgentKind::Codex, "empty-model")
            .unwrap_err();

        assert_eq!(error, "请先为档案配置至少一个模型");
        assert!(app_config
            .agent_profile_registry
            .active_profile_ids
            .is_empty());
    }

    #[test]
    fn 空默认模型档案不会触发原生写入() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("empty-model", "model-a");
        profile.models.clear();
        profile.default_model.clear();
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();
        let mut wrote_native = false;

        let error = activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "empty-model",
            |_| {
                wrote_native = true;
                Ok::<(), String>(())
            },
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap_err();

        assert_eq!(error, "请先为档案配置至少一个模型");
        assert!(!wrote_native);
    }

    #[test]
    fn updating_active_profile_model_changes_only_the_active_profile() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("codex", "model-a");
        profile.models.push(ProfileModel {
            id: "model-b".to_string(),
            name: None,
            context_window: None,
        });
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();

        set_active_profile_default_model_in_config(&mut app_config, AgentKind::Codex, "model-b")
            .unwrap();

        assert_eq!(
            app_config.agent_profile_registry.profiles[0].default_model,
            "model-b"
        );
    }

    #[test]
    fn updating_active_profile_model_rejects_model_not_in_profile() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();

        let error = set_active_profile_default_model_in_config(
            &mut app_config,
            AgentKind::Codex,
            "model-b",
        )
        .unwrap_err();

        assert_eq!(error, "默认模型必须属于当前启用档案的模型列表");
        assert_eq!(
            app_config.agent_profile_registry.profiles[0].default_model,
            "model-a"
        );
    }

    #[test]
    fn activation_native_write_failure_keeps_config_and_skips_save() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let saved = std::cell::Cell::new(false);

        let error = activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "codex",
            |_| Err::<(), _>("原生写入失败".to_string()),
            |_| Ok(()),
            |_| {
                saved.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "原生写入失败");
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
        assert!(!saved.get());
    }

    #[test]
    fn activation_saves_only_after_native_write_and_active_id_update() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        let native_written = std::cell::Cell::new(false);
        let saved = std::cell::Cell::new(false);

        activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "codex",
            |_| {
                native_written.set(true);
                Ok(())
            },
            |_| Ok(()),
            |config| {
                assert!(native_written.get());
                assert_eq!(
                    config
                        .agent_profile_registry
                        .active_profile_ids
                        .get(&AgentKind::Codex),
                    Some(&"codex".to_string())
                );
                saved.set(true);
                Ok(())
            },
        )
        .unwrap();

        assert!(saved.get());
    }

    #[test]
    fn 保存成功后返回原生配置补偿句柄以便清理备份() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();

        let compensation = activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "codex",
            |_| Ok::<_, String>("backup-session".to_string()),
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(compensation, "backup-session");
    }

    #[test]
    fn 激活档案保存失败时补偿原生配置且不更新内存() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let compensated = std::cell::Cell::new(false);

        let error = activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "codex",
            |_| Ok("backup-session"),
            |_| {
                compensated.set(true);
                Ok(())
            },
            |_| Err("保存配置失败".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "保存配置失败");
        assert!(compensated.get());
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn 激活档案保存和补偿均失败时返回双重错误并保留内存() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("codex", "model-a");
        if let NativeProfileConfig::Codex { api_key, .. } = &mut profile.native_config {
            *api_key = "secret-key".to_string();
        }
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();
        let before = serde_json::to_value(&app_config).unwrap();

        let error = activate_agent_profile_transaction(
            &mut app_config,
            AgentKind::Codex,
            "codex",
            |_| Ok("backup-session"),
            |_| Err("恢复失败: secret-key".to_string()),
            |_| Err("保存失败: secret-key".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("保存失败: secret-key"));
        assert!(error.contains("恢复失败: secret-key"));
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn 更新活动档案保存失败时补偿原生配置且不更新内存() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let compensated = std::cell::Cell::new(false);

        let error = upsert_agent_profile_transaction(
            &mut app_config,
            codex_profile("codex", "model-a"),
            |_| Ok("backup-session"),
            |_| {
                compensated.set(true);
                Ok(())
            },
            |_| Err("保存配置失败".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "保存配置失败");
        assert!(compensated.get());
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn 删除活动档案保存失败时补偿原生配置且不更新内存() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let compensated = std::cell::Cell::new(false);

        let error = delete_agent_profile_transaction(
            &mut app_config,
            "codex",
            |_| Ok("backup-session"),
            |_| {
                compensated.set(true);
                Ok(())
            },
            |_| Err("保存配置失败".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "保存配置失败");
        assert!(compensated.get());
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn active_model_native_write_failure_keeps_config_and_skips_save() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("codex", "model-a");
        profile.models.push(ProfileModel {
            id: "model-b".to_string(),
            name: None,
            context_window: None,
        });
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let saved = std::cell::Cell::new(false);

        let error = set_active_profile_model_transaction(
            &mut app_config,
            AgentKind::Codex,
            "model-b",
            |_| Err::<(), _>("原生写入失败".to_string()),
            |_| Ok(()),
            |_| {
                saved.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "原生写入失败");
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
        assert!(!saved.get());
    }

    #[test]
    fn 切换活动档案模型保存失败时补偿原生配置且不更新内存() {
        let mut app_config = AppConfig::default();
        let mut profile = codex_profile("codex", "model-a");
        profile.models.push(ProfileModel {
            id: "model-b".to_string(),
            name: None,
            context_window: None,
        });
        upsert_agent_profile_in_config(&mut app_config, profile).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();
        let before = serde_json::to_value(&app_config).unwrap();
        let compensated = std::cell::Cell::new(false);

        let error = set_active_profile_model_transaction(
            &mut app_config,
            AgentKind::Codex,
            "model-b",
            |_| Ok("backup-session"),
            |_| {
                compensated.set(true);
                Ok(())
            },
            |_| Err("保存配置失败".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "保存配置失败");
        assert!(compensated.get());
        assert_eq!(serde_json::to_value(&app_config).unwrap(), before);
    }

    #[test]
    fn deleting_active_profile_clears_its_active_id() {
        let mut app_config = AppConfig::default();
        upsert_agent_profile_in_config(&mut app_config, codex_profile("codex", "model-a")).unwrap();
        set_active_profile_in_config(&mut app_config, AgentKind::Codex, "codex").unwrap();

        delete_agent_profile_from_config(&mut app_config, "codex").unwrap();

        assert!(app_config.agent_profile_registry.profiles.is_empty());
        assert!(!app_config
            .agent_profile_registry
            .active_profile_ids
            .contains_key(&AgentKind::Codex));
    }

    #[test]
    fn profile_connection_uses_anthropic_settings_for_claude_code() {
        let profile = AgentProviderProfile {
            id: "claude".to_string(),
            agent_kind: AgentKind::ClaudeCode,
            name: "Claude".to_string(),
            note: String::new(),
            models: vec![ProfileModel {
                id: "claude-model".to_string(),
                name: None,
                context_window: None,
            }],
            default_model: "claude-model".to_string(),
            native_config: NativeProfileConfig::ClaudeCode {
                settings: serde_json::json!({ "env": {
                    "ANTHROPIC_AUTH_TOKEN": "claude-secret",
                    "ANTHROPIC_BASE_URL": "https://claude.example.test"
                }}),
                requires_review: false,
            },
        };

        let connection = profile_api_connection(&profile).unwrap();

        assert_eq!(connection.protocol, ProfileApiProtocol::Anthropic);
        assert_eq!(connection.base_url, "https://claude.example.test");
        assert_eq!(connection.api_key, "claude-secret");
    }

    #[test]
    fn profile_connection_uses_openai_settings_for_codex_and_opencode() {
        let codex = codex_profile("codex", "codex-model");
        let opencode = AgentProviderProfile {
            id: "opencode".to_string(),
            agent_kind: AgentKind::Opencode,
            name: "OpenCode".to_string(),
            note: String::new(),
            models: vec![ProfileModel {
                id: "opencode-model".to_string(),
                name: None,
                context_window: None,
            }],
            default_model: "opencode-model".to_string(),
            native_config: NativeProfileConfig::OpenCode {
                api_key: "opencode-secret".to_string(),
                openai_base_url: "https://opencode.example.test/v1".to_string(),
                provider_key: None,
                npm: None,
                models_config: None,
                extra_options: None,
                advanced_config: None,
                requires_review: false,
            },
        };

        let codex_connection = profile_api_connection(&codex).unwrap();
        let opencode_connection = profile_api_connection(&opencode).unwrap();

        assert_eq!(
            codex_connection.protocol,
            ProfileApiProtocol::OpenAiCompatible
        );
        assert_eq!(
            opencode_connection.protocol,
            ProfileApiProtocol::OpenAiCompatible
        );
        assert_eq!(
            opencode_connection.base_url,
            "https://opencode.example.test/v1"
        );
    }

    #[test]
    fn profile_errors_do_not_include_api_keys() {
        let profile = codex_profile("codex", "model-a");
        let error = redact_profile_error("连接失败: Bearer test-key", &profile);

        assert_eq!(error, "连接失败: Bearer [已脱敏]");
    }

    #[test]
    fn fetching_models_reads_only_the_requested_agent_profile() {
        let mut app_config = AppConfig::default();
        let mut codex = codex_profile("codex", "model-a");
        codex.models = vec![ProfileModel {
            id: "model-a".to_string(),
            name: Some("模型 A".to_string()),
            context_window: Some(128_000),
        }];
        upsert_agent_profile_in_config(&mut app_config, codex).unwrap();

        let models = profile_models_from_config(&app_config, AgentKind::Codex, "codex").unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "model-a");
        assert_eq!(models[0].context_window, Some(128_000));
    }

    #[test]
    fn applying_codex_profile_writes_native_config_files() {
        let temp_dir =
            std::env::temp_dir().join(format!("codemux-provider-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let paths = NativeConfigPaths::new(
            temp_dir.join(".claude"),
            temp_dir.join(".codex"),
            temp_dir.join(".config/opencode"),
        );
        let profile = codex_profile("codex", "model-a");

        apply_native_profile_config(&paths, temp_dir.join("backups"), &profile).unwrap();

        assert!(paths.codex_auth_path().exists());
        assert!(paths.codex_config_path().exists());
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn codex_sdk_mode_can_be_updated() {
        let mut app_config = AppConfig::default();

        apply_agent_config_update(
            &mut app_config,
            AgentKind::Codex,
            serde_json::json!({ "sdk_mode": "agent" }),
        )
        .unwrap();

        assert_eq!(app_config.agent_configs.codex.sdk_mode, "agent");
    }

    #[test]
    fn codex_sdk_mode_rejects_invalid_values_without_changing_config() {
        let mut app_config = AppConfig::default();
        app_config.agent_configs.codex.sdk_mode = "responses".to_string();

        let error = apply_agent_config_update(
            &mut app_config,
            AgentKind::Codex,
            serde_json::json!({ "sdk_mode": "invalid" }),
        )
        .unwrap_err();

        assert_eq!(error, "Unsupported Codex sdk_mode: invalid");
        assert_eq!(app_config.agent_configs.codex.sdk_mode, "responses");
    }

    #[test]
    fn deleting_provider_falls_back_to_first_remaining() {
        let mut app_config = AppConfig::default();
        let fallback_id = "fallback-provider".to_string();
        app_config.providers.push(Provider {
            id: fallback_id.clone(),
            name: "旧版回退供应商".to_string(),
            api_key: String::new(),
            anthropic_base_url: String::new(),
            openai_base_url: String::new(),
            default_model: String::new(),
            models: Vec::new(),
            context_1m: None,
            codex_needs_proxy: None,
        });
        app_config.active_provider_id = Some("provider-1".to_string());

        cleanup_provider_references(&mut app_config, "provider-1");

        assert_eq!(app_config.active_provider_id, Some(fallback_id));
    }
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, app: AppHandle, theme: String) -> Result<(), String> {
    info!(target: "provider", "Setting theme theme={}", theme);
    let mut config = state.config.lock().unwrap();
    config.theme = match theme.as_str() {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    };
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_compact_ai_output(
    state: State<'_, AppState>,
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    info!(target: "provider", "Setting compact AI output enabled={}", enabled);
    let mut config = state.config.lock().unwrap();
    config.compact_ai_output = enabled;
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_notification_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    settings: NotificationSettings,
) -> Result<(), String> {
    if !matches!(
        settings.sound.as_str(),
        "ding" | "chime" | "bell" | "success"
    ) {
        return Err(format!(
            "Unsupported notification sound: {}",
            settings.sound
        ));
    }

    info!(
        target: "provider",
        "Setting notification settings system_enabled={} sound_enabled={} sound={}",
        settings.system_enabled,
        settings.sound_enabled,
        settings.sound
    );
    let mut config = state.config.lock().unwrap();
    config.notifications = settings;
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_default_open_target(
    state: State<'_, AppState>,
    app: AppHandle,
    target: String,
) -> Result<(), String> {
    if !matches!(
        target.as_str(),
        "vscode" | "cursor" | "file_explorer" | "terminal" | "git_bash"
    ) {
        return Err(format!("Unsupported project open target: {}", target));
    }

    info!(target: "provider", "Setting default open target target={}", target);
    let mut config = state.config.lock().unwrap();
    config.default_open_target = target;
    config::save_config(&app, &config)?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub owned_by: String,
}

/// Known compatibility suffixes to strip when building candidate URLs.
const COMPAT_SUFFIXES: &[&str] = &["/anthropic", "/claudecode", "/coding", "/v1"];

/// Build candidate model-list URLs from a base URL, trying multiple patterns.
fn build_model_urls(base_url: &str) -> Vec<String> {
    let base = base_url.trim_end_matches('/');
    let mut candidates: Vec<String> = Vec::new();

    // If base already contains /v1, just append /models
    if base.ends_with("/v1") {
        candidates.push(format!("{}/models", base));
        return candidates;
    }

    // Try standard /v1/models
    candidates.push(format!("{}/v1/models", base));

    // Try stripping known compat suffixes and retry
    for suffix in COMPAT_SUFFIXES {
        if let Some(stripped) = base.strip_suffix(suffix) {
            candidates.push(format!("{}/v1/models", stripped));
            candidates.push(format!("{}/models", stripped));
        }
    }

    // Deduplicate while preserving order
    candidates.dedup();
    candidates
}

#[tauri::command]
pub async fn fetch_provider_models(
    api_key: String,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    info!(target: "provider", "Fetching provider models base_url={}", base_url);
    if base_url.trim().is_empty() {
        return Err("请填写 Base URL".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("请填写 API Key".to_string());
    }

    let candidates = build_model_urls(&base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut last_error = String::new();

    for url in &candidates {
        let resp = match client
            .get(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() {
                    return Err("请求超时".to_string());
                }
                last_error = format!("请求失败: {}", e);
                continue;
            }
        };

        let status = resp.status().as_u16();

        // 401/403 → auth failure, stop immediately
        if status == 401 || status == 403 {
            return Err("认证失败，请检查 API Key".to_string());
        }

        // 404/405 → try next candidate
        if status == 404 || status == 405 {
            last_error = format!("HTTP {}", status);
            continue;
        }

        // Other non-2xx → stop
        if !(200..300).contains(&status) {
            return Err(format!("请求失败: HTTP {}", status));
        }

        // Parse response
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|_| "该接口不支持获取模型".to_string())?;

        let data = body["data"].as_array().ok_or("该接口不支持获取模型")?;

        let mut models: Vec<ModelInfo> = data
            .iter()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                Some(ModelInfo {
                    id: id.to_string(),
                    owned_by: m["owned_by"].as_str().unwrap_or("unknown").to_string(),
                })
            })
            .collect();

        models.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok(models);
    }

    // All candidates failed
    if last_error.contains("404") || last_error.contains("405") {
        Err("接口地址未找到".to_string())
    } else {
        Err(format!("获取失败: {}", last_error))
    }
}

/// Test a provider by sending a streaming request. Returns model name on success.
#[tauri::command]
pub async fn test_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<String, String> {
    info!(target: "provider", "Testing provider provider_id={}", provider_id);
    let provider = {
        let config = state.config.lock().unwrap();
        config
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .cloned()
            .ok_or("供应商不存在")?
    };

    let max_retries = 2;
    let mut last_error = String::new();

    for attempt in 0..=max_retries {
        match test_provider_once(&provider).await {
            Ok(model) => return Ok(model),
            Err(e) => {
                last_error = e;
                // Only retry on timeout-like errors
                if (last_error.contains("超时")
                    || last_error.contains("timeout")
                    || last_error.contains("连接"))
                    && attempt < max_retries
                {
                    continue;
                }
                return Err(last_error);
            }
        }
    }

    Err(last_error)
}

/// Single test attempt: try Anthropic endpoint first, then OpenAI.
async fn test_provider_once(provider: &Provider) -> Result<String, String> {
    let model = if provider.default_model.is_empty() {
        "claude-haiku-4-5-20251001".to_string()
    } else {
        provider.default_model.clone()
    };

    // Try Anthropic endpoint first
    if !provider.anthropic_base_url.is_empty() && !provider.api_key.is_empty() {
        match test_anthropic_stream(&provider.anthropic_base_url, &provider.api_key, &model).await {
            Ok(()) => return Ok(model),
            Err(e) => {
                // If auth failure, don't try OpenAI
                if e.contains("认证失败") {
                    return Err(e);
                }
                // Otherwise fall through to try OpenAI
                if provider.openai_base_url.is_empty() {
                    return Err(e);
                }
            }
        }
    }

    // Try OpenAI endpoint
    if !provider.openai_base_url.is_empty() && !provider.api_key.is_empty() {
        return test_openai_stream(&provider.openai_base_url, &provider.api_key, &model)
            .await
            .map(|_| model);
    }

    Err("请配置 Base URL 和 API Key".to_string())
}

/// Test Anthropic streaming endpoint. Returns Ok(()) if first chunk received.
async fn test_anthropic_stream(base_url: &str, api_key: &str, model: &str) -> Result<(), String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "请求超时".to_string()
            } else {
                format!("连接失败: {}", e)
            }
        })?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("认证失败，请检查 API Key".to_string());
    }
    if !(200..300).contains(&status) {
        return Err(format!("请求失败: HTTP {}", status));
    }

    // Read stream until first chunk received
    let mut stream = resp.bytes_stream();
    if let Some(chunk) = stream.next().await {
        chunk.map_err(|e| format!("流读取失败: {}", e))?;
        return Ok(());
    }

    Err("未收到响应".to_string())
}

/// Test OpenAI-compatible streaming endpoint. Returns Ok(()) if first chunk received.
async fn test_openai_stream(base_url: &str, api_key: &str, model: &str) -> Result<(), String> {
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "请求超时".to_string()
            } else {
                format!("连接失败: {}", e)
            }
        })?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("认证失败，请检查 API Key".to_string());
    }
    if !(200..300).contains(&status) {
        return Err(format!("请求失败: HTTP {}", status));
    }

    let mut stream = resp.bytes_stream();
    if let Some(chunk) = stream.next().await {
        chunk.map_err(|e| format!("流读取失败: {}", e))?;
        return Ok(());
    }

    Err("未收到响应".to_string())
}
