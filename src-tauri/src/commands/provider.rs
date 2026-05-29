use tauri::{AppHandle, State};
use crate::AppState;
use crate::config::types::{AppConfig, Provider, Theme};
use crate::config;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_provider(state: State<'_, AppState>, app: AppHandle, provider: Provider) -> Result<(), String> {
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
pub fn delete_provider(state: State<'_, AppState>, app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.providers.retain(|p| p.id != provider_id);

    // If deleted provider was active, clear active_provider_id
    if config.active_provider_id.as_deref() == Some(&provider_id) {
        config.active_provider_id = config.providers.first().map(|p| p.id.clone());
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
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    };
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_provider_models(api_key: String, base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models = body["data"]
        .as_array()
        .ok_or("Response missing 'data' array")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}
