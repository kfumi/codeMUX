use tauri::{AppHandle, State};
use crate::AppState;
use crate::config::types::{AppConfig, Provider, Theme};
use crate::config;
use futures::StreamExt;

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
        if base.ends_with(suffix) {
            let stripped = &base[..base.len() - suffix.len()];
            candidates.push(format!("{}/v1/models", stripped));
            candidates.push(format!("{}/models", stripped));
        }
    }

    // Deduplicate while preserving order
    candidates.dedup();
    candidates
}

#[tauri::command]
pub async fn fetch_provider_models(api_key: String, base_url: String) -> Result<Vec<ModelInfo>, String> {
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

        let data = body["data"]
            .as_array()
            .ok_or("该接口不支持获取模型")?;

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
pub async fn test_provider(state: State<'_, AppState>, provider_id: String) -> Result<String, String> {
    let provider = {
        let config = state.config.lock().unwrap();
        config.providers.iter().find(|p| p.id == provider_id).cloned()
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
                if last_error.contains("超时") || last_error.contains("timeout") || last_error.contains("连接") {
                    if attempt < max_retries {
                        continue;
                    }
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
        return test_openai_stream(&provider.openai_base_url, &provider.api_key, &model).await
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

    let resp = client.post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "请求超时".to_string() } else { format!("连接失败: {}", e) })?;

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

    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "请求超时".to_string() } else { format!("连接失败: {}", e) })?;

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
