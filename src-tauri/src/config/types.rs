use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub providers: Vec<Provider>,
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
        let id = uuid::Uuid::new_v4().to_string();
        Self {
            providers: vec![Provider {
                id: id.clone(),
                name: "默认".to_string(),
                api_key: String::new(),
                anthropic_base_url: "https://api.anthropic.com".to_string(),
                openai_base_url: String::new(),
                default_model: "claude-sonnet-4-20250514".to_string(),
            }],
            active_provider_id: Some(id),
            theme: Theme::System,
        }
    }
}
