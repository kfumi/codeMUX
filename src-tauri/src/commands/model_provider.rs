use crate::config::{self, types::AppConfig};
use crate::model_providers::{
    builtin_templates, instantiate_template, is_provider_usable, required_protocol, select_endpoint,
    validate_provider, BuiltinProviderTemplate, ModelProvider, Protocol,
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

fn upsert_model_provider_inner(
    state: &State<'_, AppState>,
    app: &AppHandle,
    provider: ModelProvider,
) -> Result<(), String> {
    validate_provider(&provider)?;
    let mut config = state.config.lock().unwrap();
    if let Some(existing) = config
        .model_providers
        .iter_mut()
        .find(|item| item.id == provider.id)
    {
        *existing = provider;
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
    provider.enabled = enabled;
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn test_model_provider(
    state: State<'_, AppState>,
    provider_id: String,
    protocol: Option<Protocol>,
) -> Result<String, String> {
    let config = state.config.lock().unwrap();
    let provider = config
        .model_providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| format!("供应商不存在: {provider_id}"))?;

    let protocol = protocol
        .or_else(|| {
            provider
                .endpoints
                .iter()
                .find(|endpoint| !endpoint.base_url.trim().is_empty())
                .map(|endpoint| endpoint.protocol)
        })
        .ok_or_else(|| "供应商没有可用协议端点".to_string())?;

    let endpoint = select_endpoint(provider, protocol)
        .ok_or_else(|| format!("缺少协议端点: {}", protocol.as_str()))?;
    let api_key = crate::model_providers::effective_api_key(provider, endpoint);
    if api_key.is_empty() {
        return Err("API Key 未配置".to_string());
    }

    // Reuse existing HTTP helpers from provider commands when available; lightweight check here.
    Ok(format!(
        "ok: protocol={} base_url={}",
        protocol.as_str(),
        endpoint.base_url
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
