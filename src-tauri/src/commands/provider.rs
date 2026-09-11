use crate::config::types::{
    AgentKind, AppConfig, AttachmentEnrichmentConfig, ClaudeCodeAgentConfigUpdate,
    CodexAgentConfigUpdate, GitSettingsConfig, NotificationSettings, OpenCodeAgentConfigUpdate,
    Provider, Theme,
};
use crate::AppState;
use futures::StreamExt;
use log::{debug, info};
use std::str::FromStr;
use std::sync::Arc;

use crate::daemon::DaemonState;
use tauri::State;

const AGENT_PROVIDER_PROFILE_RETIRED: &str =
    "AgentProviderProfile 已退役（ADR 0005）。请使用模型供应商（Model Provider）配置。";

fn agent_provider_profile_retired_err<T>() -> Result<T, String> {
    Err(AGENT_PROVIDER_PROFILE_RETIRED.to_string())
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
            if let Some(provider_id) = update.default_provider_id {
                app_config.agent_configs.claude_code.default_provider_id = Some(provider_id);
            }
            if let Some(model) = update.default_model {
                app_config.agent_configs.claude_code.default_model = Some(model);
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

            if let Some(provider_id) = update.default_provider_id {
                app_config.agent_configs.codex.default_provider_id = Some(provider_id);
            }
            if let Some(model) = update.default_model {
                app_config.agent_configs.codex.default_model = Some(model);
            }
            if let Some(permission_config) = update.permission_config {
                if !matches!(
                    permission_config.workflow_mode.as_str(),
                    "read-only" | "auto" | "auto-review" | "full-access"
                ) {
                    return Err(format!(
                        "Unsupported Codex workflowMode: {}",
                        permission_config.workflow_mode
                    ));
                }
                app_config.agent_configs.codex.permission_config = permission_config;
            }
        }
        AgentKind::GeminiCli => {}
        AgentKind::Pi => {
            let update: crate::config::types::PiAgentConfigUpdate =
                serde_json::from_value(config).map_err(|e| format!("Invalid pi config: {}", e))?;

            if let Some(provider_id) = update.default_provider_id {
                app_config.agent_configs.pi.default_provider_id = Some(provider_id);
            }
            if let Some(model) = update.default_model {
                app_config.agent_configs.pi.default_model = Some(model);
            }
            if let Some(permission_config) = update.permission_config {
                if !matches!(
                    permission_config.execution_mode.as_str(),
                    "confirm_before_edit" | "auto_edit" | "full_access"
                ) {
                    return Err(format!(
                        "Unsupported pi executionMode: {}",
                        permission_config.execution_mode
                    ));
                }
                app_config.agent_configs.pi.permission_config = Some(permission_config);
            }
        }
        AgentKind::Opencode => {
            let update: OpenCodeAgentConfigUpdate = serde_json::from_value(config)
                .map_err(|e| format!("Invalid OpenCode config: {}", e))?;

            if let Some(provider_id) = update.default_provider_id {
                app_config.agent_configs.opencode.default_provider_id = Some(provider_id);
            }
            if let Some(model) = update.default_model {
                app_config.agent_configs.opencode.default_model = Some(model);
            }
            if let Some(permission_config) = update.permission_config {
                app_config.agent_configs.opencode.permission_config = permission_config;
            }
        }
    }

    Ok(())
}

fn redact_config_for_frontend(app_config: &AppConfig) -> AppConfig {
    let mut redacted = app_config.clone();
    // Model Provider keys are shown in Settings (password input + reveal toggle).
    // Only legacy unified providers stay redacted.
    for provider in &mut redacted.providers {
        provider.api_key.clear();
    }
    redacted
}

#[tauri::command]
pub fn upsert_agent_provider_profile(_profile: serde_json::Value) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn activate_agent_provider_profile(
    _agent_kind: String,
    _profile_id: String,
) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn activate_default_claude_supplier() -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn activate_default_codex_supplier() -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn activate_default_opencode_supplier() -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn set_active_agent_profile_model(
    _agent_kind: String,
    _default_model: String,
) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn delete_agent_provider_profile(_profile_id: String) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn fetch_agent_profile_models(
    _agent_kind: String,
    _profile_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub async fn test_agent_provider_profile(
    _agent_kind: String,
    _profile_id: String,
) -> Result<String, String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn get_config(state: State<'_, Arc<AppState>>) -> AppConfig {
    get_config_for_companion(state.inner())
}

pub fn get_config_for_companion(state: &AppState) -> AppConfig {
    debug!(target: "provider", "Loading app config");
    redact_config_for_frontend(&state.config.lock().unwrap())
}

#[tauri::command]
pub fn update_provider(_provider: Provider) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn delete_provider(_provider_id: String) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn set_active_provider(_provider_id: String) -> Result<(), String> {
    agent_provider_profile_retired_err()
}

#[tauri::command]
pub fn set_default_agent_kind(
    daemon: State<'_, Arc<DaemonState>>,
    agent_kind: String,
) -> Result<(), String> {
    set_default_agent_kind_for_companion(&daemon.app, &daemon.roots, agent_kind)
}

pub fn set_default_agent_kind_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    agent_kind: String,
) -> Result<(), String> {
    info!(target: "provider", "Setting default agent kind agent_kind={}", agent_kind);
    let mut config = state.config.lock().unwrap();
    config.agent_defaults.default_agent_kind = AgentKind::from_str(&agent_kind)?;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn update_agent_config(
    daemon: State<'_, Arc<DaemonState>>,
    agent_kind: String,
    config: serde_json::Value,
) -> Result<(), String> {
    update_agent_config_for_companion(&daemon.app, &daemon.roots, agent_kind, config)
}

pub fn update_agent_config_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    agent_kind: String,
    config: serde_json::Value,
) -> Result<(), String> {
    info!(target: "provider", "Updating agent config agent_kind={}", agent_kind);
    let mut app_config = state.config.lock().unwrap();
    apply_agent_config_update(&mut app_config, AgentKind::from_str(&agent_kind)?, config)?;

    crate::config::save_config(roots, &app_config)?;
    Ok(())
}

#[tauri::command]
pub fn set_theme(daemon: State<'_, Arc<DaemonState>>, theme: String) -> Result<(), String> {
    set_theme_for_companion(&daemon.app, &daemon.roots, theme)
}

pub fn set_theme_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    theme: String,
) -> Result<(), String> {
    info!(target: "provider", "Setting theme theme={}", theme);
    let mut config = state.config.lock().unwrap();
    config.theme = match theme.as_str() {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    };
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_compact_ai_output(
    daemon: State<'_, Arc<DaemonState>>,
    enabled: bool,
) -> Result<(), String> {
    set_compact_ai_output_for_companion(&daemon.app, &daemon.roots, enabled)
}

pub fn set_compact_ai_output_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    enabled: bool,
) -> Result<(), String> {
    info!(target: "provider", "Setting compact AI output enabled={}", enabled);
    let mut config = state.config.lock().unwrap();
    config.compact_ai_output = enabled;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_immediate_run_mode(
    daemon: State<'_, Arc<DaemonState>>,
    mode: String,
) -> Result<(), String> {
    set_immediate_run_mode_for_companion(&daemon.app, &daemon.roots, mode)
}

pub fn set_immediate_run_mode_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    mode: String,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "steer" | "interrupt") {
        return Err(format!("Unsupported immediate run mode: {}", mode));
    }

    info!(target: "provider", "Setting immediate run mode mode={}", mode);
    let mut config = state.config.lock().unwrap();
    config.immediate_run_mode = mode;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_attachment_enrichment(
    daemon: State<'_, Arc<DaemonState>>,
    enrichment: AttachmentEnrichmentConfig,
) -> Result<(), String> {
    set_attachment_enrichment_for_companion(&daemon.app, &daemon.roots, enrichment)
}

pub fn set_attachment_enrichment_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    mut enrichment: AttachmentEnrichmentConfig,
) -> Result<(), String> {
    info!(
        target: "provider",
        "Setting image recognition enabled={} base_url={} model={}",
        enrichment.enabled,
        enrichment.base_url,
        enrichment.model
    );
    let mut config = state.config.lock().unwrap();
    let existing = config.attachment_enrichment.clone();
    if enrichment.api_key.trim().is_empty()
        && (!existing.api_key.trim().is_empty() || enrichment.api_key_configured)
    {
        enrichment.api_key = existing.api_key;
    }
    enrichment.api_key_configured = false;
    enrichment.provider_id = None;
    config.attachment_enrichment = enrichment;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_notification_settings(
    daemon: State<'_, Arc<DaemonState>>,
    settings: NotificationSettings,
) -> Result<(), String> {
    set_notification_settings_for_companion(&daemon.app, &daemon.roots, settings)
}

pub fn set_notification_settings_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
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
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_default_open_target(
    daemon: State<'_, Arc<DaemonState>>,
    target: String,
) -> Result<(), String> {
    set_default_open_target_for_companion(&daemon.app, &daemon.roots, target)
}

pub fn set_default_open_target_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
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
    crate::config::save_config(roots, &config)?;
    Ok(())
}

const MAX_GIT_INSTRUCTIONS_CHARS: usize = 8_000;

pub fn set_browser_control_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    settings: crate::config::types::BrowserControlConfig,
) -> Result<(), String> {
    info!(
        target: "provider",
        "Setting browser control enabled={} ignore_certificate_errors={}",
        settings.enabled, settings.ignore_certificate_errors
    );
    let mut config = state.config.lock().unwrap();
    config.browser = settings;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_git_settings(
    daemon: State<'_, Arc<DaemonState>>,
    settings: GitSettingsConfig,
) -> Result<(), String> {
    set_git_settings_for_companion(&daemon.app, &daemon.roots, settings)
}

pub fn set_git_settings_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    mut settings: GitSettingsConfig,
) -> Result<(), String> {
    settings.commit_instructions = settings.commit_instructions.trim().to_string();
    settings.pull_request_instructions = settings.pull_request_instructions.trim().to_string();
    settings.model = settings.model.trim().to_string();
    if settings.commit_instructions.chars().count() > MAX_GIT_INSTRUCTIONS_CHARS {
        return Err("提交说明过长（最多 8000 字符）".to_string());
    }
    if settings.pull_request_instructions.chars().count() > MAX_GIT_INSTRUCTIONS_CHARS {
        return Err("拉取请求指令过长（最多 8000 字符）".to_string());
    }

    info!(
        target: "provider",
        "Setting git settings commit_len={} pr_len={} provider_id={:?} model={}",
        settings.commit_instructions.chars().count(),
        settings.pull_request_instructions.chars().count(),
        settings.provider_id,
        settings.model
    );
    let mut config = state.config.lock().unwrap();
    if let Some(provider_id) = settings.provider_id.as_deref() {
        let provider = config
            .model_providers
            .iter()
            .find(|provider| provider.id == provider_id);
        match provider {
            Some(provider) if provider.enabled => {}
            _ => return Err("所选供应商不存在或已禁用".to_string()),
        }
    }
    config.git = settings;
    crate::config::save_config(roots, &config)?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchAppConfigRequest {
    pub theme: Option<String>,
    pub compact_ai_output: Option<bool>,
    pub immediate_run_mode: Option<String>,
    pub attachment_enrichment: Option<AttachmentEnrichmentConfig>,
    pub notifications: Option<NotificationSettings>,
    pub default_open_target: Option<String>,
    pub git: Option<GitSettingsConfig>,
    pub browser: Option<crate::config::types::BrowserControlConfig>,
    pub default_agent_kind: Option<String>,
    pub agent_kind: Option<String>,
    pub agent_config: Option<serde_json::Value>,
}

pub fn patch_app_config_for_companion(
    state: &AppState,
    roots: &crate::paths::PathRoots,
    patch: PatchAppConfigRequest,
) -> Result<(), String> {
    if let Some(theme) = patch.theme {
        set_theme_for_companion(state, roots, theme)?;
    }
    if let Some(enabled) = patch.compact_ai_output {
        set_compact_ai_output_for_companion(state, roots, enabled)?;
    }
    if let Some(mode) = patch.immediate_run_mode {
        set_immediate_run_mode_for_companion(state, roots, mode)?;
    }
    if let Some(enrichment) = patch.attachment_enrichment {
        set_attachment_enrichment_for_companion(state, roots, enrichment)?;
    }
    if let Some(settings) = patch.notifications {
        set_notification_settings_for_companion(state, roots, settings)?;
    }
    if let Some(target) = patch.default_open_target {
        set_default_open_target_for_companion(state, roots, target)?;
    }
    if let Some(settings) = patch.git {
        set_git_settings_for_companion(state, roots, settings)?;
    }
    if let Some(settings) = patch.browser {
        set_browser_control_for_companion(state, roots, settings)?;
    }
    if let Some(agent_kind) = patch.default_agent_kind {
        set_default_agent_kind_for_companion(state, roots, agent_kind)?;
    }
    if let (Some(agent_kind), Some(config)) = (patch.agent_kind, patch.agent_config) {
        update_agent_config_for_companion(state, roots, agent_kind, config)?;
    }
    Ok(())
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub owned_by: String,
    /// Upstream display name when the provider returns one that differs from `id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Pick the first non-empty display-name field from an OpenAI-compatible model object.
fn extract_model_display_name(model: &serde_json::Value, model_id: &str) -> Option<String> {
    const KEYS: &[&str] = &["display_name", "displayName", "model_name", "name"];
    for key in KEYS {
        if let Some(raw) = model.get(*key).and_then(serde_json::Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && trimmed != model_id {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn model_info_from_json(model: &serde_json::Value) -> Option<ModelInfo> {
    let id = model
        .get("id")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    Some(ModelInfo {
        owned_by: model
            .get("owned_by")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        name: extract_model_display_name(model, &id),
        id,
    })
}

const OPENCODE_FREE_MODELS_URL: &str = "https://opencode.ai/zen/v1/models";

#[tauri::command]
pub async fn fetch_opencode_free_models() -> Result<Vec<ModelInfo>, String> {
    fetch_opencode_free_models_for_companion().await
}

pub async fn fetch_opencode_free_models_for_companion() -> Result<Vec<ModelInfo>, String> {
    info!(target: "provider", "Fetching OpenCode free models from official catalog");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {}", error))?;
    let response = client
        .get(OPENCODE_FREE_MODELS_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "请求 OpenCode 官方模型目录超时".to_string()
            } else {
                format!("请求 OpenCode 官方模型目录失败: {}", error)
            }
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "OpenCode 官方模型目录返回 HTTP {}",
            response.status()
        ));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("解析 OpenCode 官方模型目录失败: {}", error))?;
    let data = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "OpenCode 官方模型目录格式无效".to_string())?;

    let mut models: Vec<ModelInfo> = data
        .iter()
        .filter_map(|model| {
            let info = model_info_from_json(model)?;
            let is_free = info.id.ends_with("-free") || info.id == "big-pickle";
            if !is_free {
                return None;
            }
            Some(ModelInfo {
                owned_by: model
                    .get("owned_by")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("opencode")
                    .to_string(),
                ..info
            })
        })
        .collect();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    if models.is_empty() {
        return Err("OpenCode 官方模型目录中没有免费模型".to_string());
    }
    Ok(models)
}

/// Known compatibility suffixes to strip when building candidate URLs.
const COMPAT_SUFFIXES: &[&str] = &["/anthropic", "/claudecode", "/coding", "/v1"];

/// Build candidate model-list URLs from a base URL, trying multiple patterns.
fn build_model_urls(base_url: &str) -> Vec<String> {
    let base = base_url.trim().trim_end_matches('/');
    let mut candidates: Vec<String> = Vec::new();

    // Prefer the path that matches how the base was entered.
    if base.ends_with("/v1") {
        candidates.push(format!("{}/models", base));
    } else {
        candidates.push(format!("{}/v1/models", base));
        // Many OpenAI-compatible gateways already include a version segment
        // (e.g. /api/paas/v4) and expose models at `{base}/models`.
        candidates.push(format!("{}/models", base));
    }

    // Try stripping known compat suffixes and retry
    for suffix in COMPAT_SUFFIXES {
        if let Some(stripped) = base.strip_suffix(suffix) {
            let stripped = stripped.trim_end_matches('/');
            if stripped.is_empty() {
                continue;
            }
            candidates.push(format!("{}/v1/models", stripped));
            candidates.push(format!("{}/models", stripped));
        }
    }

    // Deduplicate while preserving order
    candidates.dedup();
    candidates
}

/// Probe OpenAI-compatible `GET …/models` candidates. Returns models and the URL that worked.
pub(crate) async fn probe_openai_models(
    api_key: &str,
    base_url: &str,
) -> Result<(Vec<ModelInfo>, String), String> {
    if base_url.trim().is_empty() {
        return Err("请填写 Base URL".to_string());
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请填写 API Key".to_string());
    }

    let candidates = build_model_urls(base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut last_error = String::new();
    let mut saw_auth_failure = false;

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

        // Wrong path candidates may also return 401/403 — keep trying others.
        if status == 401 || status == 403 {
            saw_auth_failure = true;
            last_error = format!("HTTP {}", status);
            continue;
        }

        // 404/405 → try next candidate
        if status == 404 || status == 405 {
            last_error = format!("HTTP {}", status);
            continue;
        }

        // Other non-2xx → try next candidate
        if !(200..300).contains(&status) {
            last_error = format!("HTTP {}", status);
            continue;
        }

        // Parse response
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|_| "该接口不支持获取模型".to_string())?;

        let data = body["data"].as_array().ok_or("该接口不支持获取模型")?;

        let mut models: Vec<ModelInfo> = data.iter().filter_map(model_info_from_json).collect();

        models.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok((models, url.clone()));
    }

    // All candidates failed
    if saw_auth_failure {
        Err("认证失败，请检查 API Key 与 Base URL".to_string())
    } else if last_error.contains("404") || last_error.contains("405") {
        Err("接口地址未找到，请检查 Base URL".to_string())
    } else if last_error.is_empty() {
        Err("获取失败".to_string())
    } else {
        Err(format!("获取失败: {}", last_error))
    }
}

#[tauri::command]
pub async fn fetch_provider_models(
    api_key: String,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    fetch_provider_models_for_companion(api_key, base_url).await
}

pub async fn fetch_provider_models_for_companion(
    api_key: String,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    info!(target: "provider", "Fetching provider models base_url={}", base_url);
    let (models, _) = probe_openai_models(&api_key, &base_url).await?;
    Ok(models)
}

/// Test a provider by sending a streaming request. Returns model name on success.
#[tauri::command]
pub async fn test_provider(
    state: State<'_, Arc<AppState>>,
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

#[cfg(test)]
mod tests {
    use super::{
        agent_provider_profile_retired_err, build_model_urls, model_info_from_json,
        redact_config_for_frontend, ModelInfo, AGENT_PROVIDER_PROFILE_RETIRED,
    };
    use crate::config::types::AppConfig;

    #[test]
    fn redact_config_clears_model_provider_secrets() {
        let mut app_config = AppConfig::default();
        app_config
            .model_providers
            .push(crate::model_providers::ModelProvider {
                id: "provider-1".to_string(),
                name: "测试供应商".to_string(),
                enabled: true,
                api_key: "sk-secret".to_string(),
                api_key_configured: false,
                endpoints: vec![crate::model_providers::ProtocolEndpoint {
                    protocol: crate::model_providers::Protocol::OpenaiCompatible,
                    base_url: "https://example.com/v1".to_string(),
                    api_key_override: Some("sk-override".to_string()),
                    codex_needs_proxy: None,
                }],
                models: vec![crate::model_providers::ProviderModel {
                    id: "model".to_string(),
                    name: None,
                    context_1m: None,
                    context_window: None,
                    max_input_tokens: None,
                    max_output_tokens: None,
                    input_modalities: None,
                    supports_vision: None,
                }],
                default_model: "model".to_string(),
                builtin_template_id: None,
                opencode_provider_key: None,
                opencode_npm: None,
            });
        app_config.providers.push(crate::config::types::Provider {
            id: "legacy".to_string(),
            name: "旧供应商".to_string(),
            api_key: "legacy-secret".to_string(),
            anthropic_base_url: String::new(),
            openai_base_url: "https://example.com/v1".to_string(),
            default_model: "model".to_string(),
            models: vec!["model".to_string()],
            context_1m: None,
            codex_needs_proxy: None,
        });

        let redacted = redact_config_for_frontend(&app_config);

        assert_eq!(redacted.model_providers[0].api_key, "sk-secret");
        assert_eq!(
            redacted.model_providers[0].endpoints[0]
                .api_key_override
                .as_deref(),
            Some("sk-override")
        );
        assert_eq!(redacted.providers[0].api_key, "");
        assert_eq!(app_config.model_providers[0].api_key, "sk-secret");
    }

    #[test]
    fn model_info_prefers_upstream_display_name_fields() {
        let model = serde_json::json!({
            "id": "gpt-4o",
            "owned_by": "openai",
            "display_name": "GPT-4o"
        });
        assert_eq!(
            model_info_from_json(&model),
            Some(ModelInfo {
                id: "gpt-4o".to_string(),
                owned_by: "openai".to_string(),
                name: Some("GPT-4o".to_string()),
            })
        );

        let echoed = serde_json::json!({
            "id": "deepseek-chat",
            "owned_by": "deepseek",
            "name": "deepseek-chat"
        });
        assert_eq!(
            model_info_from_json(&echoed),
            Some(ModelInfo {
                id: "deepseek-chat".to_string(),
                owned_by: "deepseek".to_string(),
                name: None,
            })
        );
    }

    #[test]
    fn build_model_urls_includes_base_models_for_versioned_gateways() {
        let urls = build_model_urls("https://open.bigmodel.cn/api/paas/v4");
        assert!(urls.contains(&"https://open.bigmodel.cn/api/paas/v4/models".to_string()));
        assert!(urls.contains(&"https://open.bigmodel.cn/api/paas/v4/v1/models".to_string()));
    }

    #[test]
    fn build_model_urls_strips_anthropic_compat_suffix() {
        let urls = build_model_urls("https://api.deepseek.com/anthropic");
        assert!(urls.contains(&"https://api.deepseek.com/v1/models".to_string()));
    }

    #[test]
    fn retired_profile_commands_share_error_message() {
        let err: Result<(), String> = agent_provider_profile_retired_err();
        assert_eq!(err.unwrap_err(), AGENT_PROVIDER_PROFILE_RETIRED);
        assert!(AGENT_PROVIDER_PROFILE_RETIRED.contains("ADR 0005"));
    }
}
