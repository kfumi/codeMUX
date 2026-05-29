use tauri::{AppHandle, State};
use crate::AppState;
use crate::config::types::{AppConfig, ProviderConfig};
use crate::config;
use crate::provider;
use crate::provider::types::{AiProvider, ChatMessage};

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_provider(state: State<'_, AppState>, app: AppHandle, provider: ProviderConfig) -> Result<(), String> {
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
pub fn set_active_provider(state: State<'_, AppState>, app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.active_provider_id = Some(provider_id);
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, app: AppHandle, theme: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.theme = match theme.as_str() {
        "light" => crate::config::types::Theme::Light,
        "dark" => crate::config::types::Theme::Dark,
        _ => crate::config::types::Theme::System,
    };
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(provider: ProviderConfig) -> Result<String, String> {
    let provider_impl = provider::create_provider(&provider);
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Hi".to_string(),
    }];
    let model = if provider.default_model.is_empty() {
        "default".to_string()
    } else {
        provider.default_model.clone()
    };
    let response = provider_impl.send_message(messages, &model).await?;
    Ok(response)
}
