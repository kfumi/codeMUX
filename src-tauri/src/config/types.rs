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

fn default_false() -> bool {
    false
}

fn default_claude_permission_mode() -> String {
    "default".to_string()
}

fn default_codex_sandbox_mode() -> String {
    "danger-full-access".to_string()
}

fn default_codex_approval_policy() -> String {
    "never".to_string()
}

fn default_notification_sound() -> String {
    "soft".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationSettings {
    #[serde(default = "default_true")]
    pub system_enabled: bool,
    #[serde(default = "default_false")]
    pub sound_enabled: bool,
    #[serde(default = "default_notification_sound")]
    pub sound: String,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            system_enabled: true,
            sound_enabled: false,
            sound: default_notification_sound(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
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
    #[serde(default)]
    pub codex_needs_proxy: Option<bool>,
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
pub struct ClaudePermissionConfig {
    #[serde(default = "default_claude_permission_mode", rename = "permissionMode")]
    pub permission_mode: String,
}

impl Default for ClaudePermissionConfig {
    fn default() -> Self {
        Self {
            permission_mode: default_claude_permission_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexPermissionConfig {
    #[serde(default = "default_codex_sandbox_mode", rename = "sandboxMode")]
    pub sandbox_mode: String,
    #[serde(default = "default_codex_approval_policy", rename = "approvalPolicy")]
    pub approval_policy: String,
    #[serde(default = "default_true", rename = "networkAccessEnabled")]
    pub network_access_enabled: bool,
}

impl Default for CodexPermissionConfig {
    fn default() -> Self {
        Self {
            sandbox_mode: default_codex_sandbox_mode(),
            approval_policy: default_codex_approval_policy(),
            network_access_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeAgentConfig {
    #[serde(default = "default_claude_executable_mode")]
    pub executable_mode: String,
    #[serde(default = "default_true")]
    pub resume_sessions: bool,
    #[serde(default)]
    pub permission_config: ClaudePermissionConfig,
}

impl Default for ClaudeCodeAgentConfig {
    fn default() -> Self {
        Self {
            executable_mode: default_claude_executable_mode(),
            resume_sessions: true,
            permission_config: ClaudePermissionConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAgentConfig {
    #[serde(default = "default_codex_sdk_mode")]
    pub sdk_mode: String,
    #[serde(default)]
    pub permission_config: CodexPermissionConfig,
}

impl Default for CodexAgentConfig {
    fn default() -> Self {
        Self {
            sdk_mode: default_codex_sdk_mode(),
            permission_config: CodexPermissionConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeCodeAgentConfigUpdate {
    pub executable_mode: Option<String>,
    pub resume_sessions: Option<bool>,
    pub permission_config: Option<ClaudePermissionConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexAgentConfigUpdate {
    pub sdk_mode: Option<String>,
    pub permission_config: Option<CodexPermissionConfig>,
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
    #[serde(default = "default_false")]
    pub compact_ai_output: bool,
    #[serde(default)]
    pub notifications: NotificationSettings,
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
                models: vec!["claude-sonnet-4-20250514".to_string()],
                input_price: None,
                cache_read_price: None,
                output_price: None,
                context_1m: None,
                codex_needs_proxy: None,
            }],
            active_provider_id: Some(id),
            agent_defaults: AgentDefaults::default(),
            agent_configs: AgentConfigs::default(),
            compact_ai_output: false,
            notifications: NotificationSettings::default(),
            theme: Theme::System,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentKind, AppConfig};

    #[test]
    fn old_config_json_deserializes_with_agent_defaults() {
        let raw = serde_json::json!({
            "providers": [],
            "active_provider_id": null,
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert_eq!(
            config.agent_defaults.default_agent_kind,
            AgentKind::ClaudeCode
        );
        assert_eq!(config.agent_configs.claude_code.executable_mode, "auto");
        assert!(config.agent_configs.claude_code.resume_sessions);
        assert_eq!(config.agent_configs.codex.sdk_mode, "responses");
        assert!(!config.compact_ai_output);
    }

    #[test]
    fn old_config_json_deserializes_with_notification_defaults() {
        let raw = serde_json::json!({
            "providers": [],
            "active_provider_id": null,
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert!(config.notifications.system_enabled);
        assert!(!config.notifications.sound_enabled);
        assert_eq!(config.notifications.sound, "soft");
    }

    #[test]
    fn old_provider_json_deserializes_without_models() {
        let raw = serde_json::json!({
            "providers": [{
                "id": "provider-1",
                "name": "Provider",
                "api_key": "key",
                "anthropic_base_url": "https://api.anthropic.com",
                "openai_base_url": "https://api.openai.com/v1",
                "default_model": "claude-sonnet-4-20250514"
            }],
            "active_provider_id": "provider-1",
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert_eq!(config.providers[0].models, Vec::<String>::new());
        assert_eq!(
            AppConfig::default().providers[0].models,
            vec!["claude-sonnet-4-20250514"]
        );
    }
}
