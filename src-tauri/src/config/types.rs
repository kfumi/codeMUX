use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub api_type: ApiType,
    pub api_key: String,
    pub endpoint_url: String,
    pub default_model: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApiType {
    DeepSeek,
    OpenAICompatible,
    Claude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub providers: Vec<ProviderConfig>,
    pub active_provider_id: Option<String>,
    pub theme: Theme,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Theme {
    Light,
    Dark,
    System,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            providers: vec![
                ProviderConfig {
                    id: "deepseek".to_string(),
                    name: "DeepSeek".to_string(),
                    api_type: ApiType::DeepSeek,
                    api_key: String::new(),
                    endpoint_url: "https://api.deepseek.com".to_string(),
                    default_model: "deepseek-chat".to_string(),
                    is_active: false,
                },
                ProviderConfig {
                    id: "anthropic".to_string(),
                    name: "Anthropic (Claude)".to_string(),
                    api_type: ApiType::Claude,
                    api_key: String::new(),
                    endpoint_url: "https://api.anthropic.com".to_string(),
                    default_model: "claude-sonnet-4-6".to_string(),
                    is_active: true,
                },
            ],
            active_provider_id: Some("anthropic".to_string()),
            theme: Theme::System,
        }
    }
}
