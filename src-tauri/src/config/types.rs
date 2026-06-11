use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    GeminiCli,
    Opencode,
}

impl AgentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::GeminiCli => "gemini_cli",
            Self::Opencode => "opencode",
        }
    }
}

impl Default for AgentKind {
    fn default() -> Self {
        Self::ClaudeCode
    }
}

impl FromStr for AgentKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude_code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "gemini_cli" => Ok(Self::GeminiCli),
            "opencode" => Ok(Self::Opencode),
            _ => Err(format!("Unsupported agent kind: {}", value)),
        }
    }
}

fn default_agent_kind() -> AgentKind {
    AgentKind::ClaudeCode
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
    pub default_agent_kind: AgentKind,
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

#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeCodeAgentConfigUpdate {
    pub executable_mode: Option<String>,
    pub resume_sessions: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexAgentConfigUpdate {
    pub sdk_mode: Option<String>,
}

impl Default for CodexAgentConfig {
    fn default() -> Self {
        Self {
            sdk_mode: default_codex_sdk_mode(),
            default_provider_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentKind, AppConfig, CodexAgentConfigUpdate};

    #[test]
    fn old_config_json_deserializes_with_agent_defaults() {
        let raw = serde_json::json!({
            "providers": [],
            "active_provider_id": null,
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert_eq!(config.agent_defaults.default_agent_kind, AgentKind::ClaudeCode);
        assert_eq!(config.agent_configs.claude_code.executable_mode, "auto");
        assert!(config.agent_configs.claude_code.resume_sessions);
        assert_eq!(config.agent_configs.codex.sdk_mode, "responses");
        assert_eq!(config.agent_configs.codex.default_provider_id, None);
    }

    #[test]
    fn codex_update_distinguishes_missing_null_and_value() {
        let missing: CodexAgentConfigUpdate = serde_json::from_value(serde_json::json!({})).unwrap();
        let clear: CodexAgentConfigUpdate = serde_json::from_value(serde_json::json!({
            "default_provider_id": null
        }))
        .unwrap();
        let set: CodexAgentConfigUpdate = serde_json::from_value(serde_json::json!({
            "default_provider_id": "provider-1"
        }))
        .unwrap();

        assert!(matches!(missing.default_provider_id, OptionalField::Missing));
        assert!(matches!(clear.default_provider_id, OptionalField::Null));
        assert!(matches!(set.default_provider_id, OptionalField::Value(ref value) if value == "provider-1"));
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
