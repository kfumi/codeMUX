use crate::config::{self, types::AppConfig};
use crate::model_providers::{
    builtin_templates, instantiate_template, is_provider_usable, required_protocol,
    validate_provider, validate_provider_for_enable, BuiltinProviderTemplate, ModelProvider,
};
use crate::AppState;
use tauri::{AppHandle, State};

fn find_provider_mut<'a>(
    config: &'a mut AppConfig,
    provider_id: &str,
) -> Result<&'a mut ModelProvider, String> {
    config
        .model_providers
        .iter_mut()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("供应商不存在: {provider_id}"))
}

#[tauri::command]
pub fn list_builtin_provider_templates() -> Vec<BuiltinProviderTemplate> {
    builtin_templates()
}

#[tauri::command]
pub fn instantiate_builtin_provider_template(
    state: State<'_, AppState>,
    app: AppHandle,
    template_id: String,
) -> Result<ModelProvider, String> {
    let provider_id = uuid::Uuid::new_v4().to_string();
    let provider = instantiate_template(&template_id, provider_id)?;
    upsert_model_provider_inner(&state, &app, provider.clone())?;
    Ok(provider)
}

#[tauri::command]
pub fn upsert_model_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider: ModelProvider,
) -> Result<(), String> {
    upsert_model_provider_inner(&state, &app, provider)
}

fn merge_provider_secrets(mut incoming: ModelProvider, existing: Option<&ModelProvider>) -> ModelProvider {
    if let Some(existing) = existing {
        if incoming.api_key.trim().is_empty() {
            incoming.api_key = existing.api_key.clone();
        }
        for endpoint in &mut incoming.endpoints {
            let incoming_override_empty = endpoint
                .api_key_override
                .as_deref()
                .map(|key| key.trim().is_empty())
                .unwrap_or(true);
            if !incoming_override_empty {
                continue;
            }
            if let Some(previous) = existing
                .endpoints
                .iter()
                .find(|item| item.protocol == endpoint.protocol)
            {
                if previous
                    .api_key_override
                    .as_deref()
                    .is_some_and(|key| !key.trim().is_empty())
                {
                    endpoint.api_key_override = previous.api_key_override.clone();
                }
            }
        }
    }
    // Never persist the frontend-only redaction flag.
    incoming.api_key_configured = false;
    incoming
}

fn upsert_model_provider_inner(
    state: &State<'_, AppState>,
    app: &AppHandle,
    provider: ModelProvider,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    let existing = config
        .model_providers
        .iter()
        .find(|item| item.id == provider.id)
        .cloned();
    let provider = merge_provider_secrets(provider, existing.as_ref());
    if provider.enabled {
        validate_provider_for_enable(&provider)?;
    } else {
        validate_provider(&provider)?;
    }
    if let Some(slot) = config
        .model_providers
        .iter_mut()
        .find(|item| item.id == provider.id)
    {
        *slot = provider;
    } else {
        config.model_providers.push(provider);
    }
    if config.active_provider_id.is_none() {
        config.active_provider_id = config.model_providers.first().map(|item| item.id.clone());
    }
    config::save_config(app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn delete_model_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    let before = config.model_providers.len();
    config
        .model_providers
        .retain(|provider| provider.id != provider_id);
    if config.model_providers.len() == before {
        return Err(format!("供应商不存在: {provider_id}"));
    }
    if config.active_provider_id.as_deref() == Some(provider_id.as_str()) {
        config.active_provider_id = config.model_providers.first().map(|item| item.id.clone());
    }
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_active_model_provider(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    if !config
        .model_providers
        .iter()
        .any(|provider| provider.id == provider_id)
    {
        return Err(format!("供应商不存在: {provider_id}"));
    }
    config.active_provider_id = Some(provider_id);
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_model_provider_enabled(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    let provider = find_provider_mut(&mut config, &provider_id)?;
    if enabled {
        validate_provider_for_enable(provider)?;
    }
    provider.enabled = enabled;
    config::save_config(&app, &config)?;
    Ok(())
}

/// Test connection with the currently entered API key + Base URL (OpenAI-compatible GET …/models).
#[tauri::command]
pub async fn test_model_provider(api_key: String, base_url: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    if base_url.trim().is_empty() {
        return Err("请先填写 API 地址".to_string());
    }
    let (models, url) = crate::commands::provider::probe_openai_models(&api_key, &base_url).await?;
    Ok(format!(
        "连接成功：GET {}（{} 个模型）",
        url,
        models.len()
    ))
}

#[tauri::command]
pub fn provider_usable_for_agent(
    state: State<'_, AppState>,
    provider_id: String,
    agent_kind: crate::config::types::AgentKind,
) -> Result<bool, String> {
    let config = state.config.lock().unwrap();
    let provider = config
        .model_providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| format!("供应商不存在: {provider_id}"))?;
    if required_protocol(agent_kind).is_none() {
        return Ok(false);
    }
    Ok(is_provider_usable(provider, agent_kind))
}
