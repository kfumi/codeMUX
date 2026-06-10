use serde::{Deserialize, Serialize};

fn default_agent_kind() -> String {
    "claude_code".to_string()
}

fn default_claude_executable_mode() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

fn default_codex_sdk_mode() -> String {
    "responses".to_string()
}

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
    /// 1M 上下文窗口（模型名会追加 [1m]）
    #[serde(default)]
    pub context_1m: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefaults {
    #[serde(default = "default_agent_kind")]
    pub default_agent_kind: String,
}

impl Default for AgentDefaults {
    fn default() -> Self {
        Self {
            default_agent_kind: default_agent_kind(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeAgentConfig {
    #[serde(default = "default_claude_executable_mode")]
    pub executable_mode: String,
    #[serde(default = "default_true")]
    pub resume_sessions: bool,
}

impl Default for ClaudeCodeAgentConfig {
    fn default() -> Self {
        Self {
            executable_mode: default_claude_executable_mode(),
            resume_sessions: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAgentConfig {
    #[serde(default = "default_codex_sdk_mode")]
    pub sdk_mode: String,
    #[serde(default)]
    pub default_provider_id: Option<String>,
}

impl Default for CodexAgentConfig {
    fn default() -> Self {
        Self {
            sdk_mode: default_codex_sdk_mode(),
            default_provider_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfigs {
    #[serde(default)]
    pub claude_code: ClaudeCodeAgentConfig,
    #[serde(default)]
    pub codex: CodexAgentConfig,
    #[serde(default)]
    pub gemini_cli: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub opencode: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
    #[serde(default)]
    pub agent_defaults: AgentDefaults,
    #[serde(default)]
    pub agent_configs: AgentConfigs,
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
                context_1m: None,
            }],
            active_provider_id: Some(id),
            agent_defaults: AgentDefaults::default(),
            agent_configs: AgentConfigs::default(),
            theme: Theme::System,
        }
    }
}
