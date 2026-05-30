use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub default_model: String,
    /// 输入 token 单价 ($/1M tokens)
    #[serde(default)]
    pub input_price: Option<f64>,
    /// 缓存命中 token 单价 ($/1M tokens)
    #[serde(default)]
    pub cache_read_price: Option<f64>,
    /// 输出 token 单价 ($/1M tokens)
    #[serde(default)]
    pub output_price: Option<f64>,
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
                input_price: None,
                cache_read_price: None,
                output_price: None,
            }],
            active_provider_id: Some(id),
            theme: Theme::System,
        }
    }
}
