use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    #[default]
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

fn default_false() -> bool {
    false
}

fn default_claude_permission_mode() -> String {
    "default".to_string()
}

fn default_codex_workflow_mode() -> String {
    // Mirrors CODEX_DEFAULT_PERMISSIONS in the sidecar / frontend: the
    // conservative 「请求批准」tier aligned with the official Codex App.
    "auto".to_string()
}

fn default_notification_sound() -> String {
    "ding".to_string()
}

fn default_open_target() -> String {
    "file_explorer".to_string()
}

fn default_companion_port() -> u16 {
    9240
}

fn default_relay_endpoint() -> String {
    String::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionRelayConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_relay_endpoint")]
    pub endpoint: String,
    #[serde(default = "default_false")]
    pub use_tls: bool,
}

impl Default for CompanionRelayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: default_relay_endpoint(),
            use_tls: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_companion_port")]
    pub port: u16,
    #[serde(default)]
    pub desktop_id: Option<String>,
    #[serde(default)]
    pub relay: CompanionRelayConfig,
    #[serde(default = "default_listen_address")]
    pub listen_address: String,
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub pairing_code_expires_at: Option<String>,
    #[serde(default)]
    pub last_lan_ip: Option<String>,
}

fn default_listen_address() -> String {
    "0.0.0.0".to_string()
}

impl Default for CompanionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_companion_port(),
            desktop_id: None,
            relay: CompanionRelayConfig::default(),
            listen_address: default_listen_address(),
            pairing_code: None,
            pairing_code_expires_at: None,
            last_lan_ip: None,
        }
    }
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

/// Git 相关设置：提交信息 / PR 描述的 AI 生成指引与所用模型。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitSettingsConfig {
    #[serde(default)]
    pub commit_instructions: String,
    #[serde(default)]
    pub pull_request_instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: String,
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
    #[serde(default = "default_codex_workflow_mode", rename = "workflowMode")]
    pub workflow_mode: String,
    #[serde(default = "default_true", rename = "networkAccessEnabled")]
    pub network_access_enabled: bool,
}

impl Default for CodexPermissionConfig {
    fn default() -> Self {
        Self {
            workflow_mode: default_codex_workflow_mode(),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub permission_config: ClaudePermissionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts: Option<crate::provider_profiles::types::AgentTimeouts>,
}

impl Default for ClaudeCodeAgentConfig {
    fn default() -> Self {
        Self {
            executable_mode: default_claude_executable_mode(),
            resume_sessions: true,
            default_provider_id: None,
            default_model: None,
            permission_config: ClaudePermissionConfig::default(),
            timeouts: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexAgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub permission_config: CodexPermissionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts: Option<crate::provider_profiles::types::AgentTimeouts>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeCodeAgentConfigUpdate {
    pub executable_mode: Option<String>,
    pub resume_sessions: Option<bool>,
    pub default_provider_id: Option<String>,
    pub default_model: Option<String>,
    pub permission_config: Option<ClaudePermissionConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexAgentConfigUpdate {
    pub default_provider_id: Option<String>,
    pub default_model: Option<String>,
    pub permission_config: Option<CodexPermissionConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenCodeAgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts: Option<crate::provider_profiles::types::AgentTimeouts>,
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
    pub opencode: OpenCodeAgentConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachmentEnrichmentConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub api_key: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub api_key_configured: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

impl Default for AttachmentEnrichmentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: String::new(),
            api_key_configured: false,
            base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
            model: String::new(),
            provider_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// CodeMUX-owned model providers (ADR 0005).
    #[serde(default)]
    pub model_providers: Vec<crate::model_providers::ModelProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_provider_id: Option<String>,
    /// Legacy field retained only so old config.json can deserialize; cleared on load (no migration).
    #[serde(default, skip_serializing)]
    pub agent_profile_registry: crate::provider_profiles::AgentProfileRegistry,
    /// 仅存在于内存中，表示当前档案注册表由旧版供应商配置临时派生。
    #[serde(skip)]
    pub profile_registry_is_derived: bool,
    /// 仅存在于内存中，用于阻止无效的持久档案被无关设置覆盖。
    #[serde(skip)]
    pub profile_registry_validation_error: Option<String>,
    /// Legacy unified providers; cleared on load (no migration).
    #[serde(default, skip_serializing)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub agent_defaults: AgentDefaults,
    #[serde(default)]
    pub agent_configs: AgentConfigs,
    #[serde(default = "default_false")]
    pub compact_ai_output: bool,
    #[serde(default = "default_open_target")]
    pub default_open_target: String,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub git: GitSettingsConfig,
    pub theme: Theme,
    #[serde(default)]
    pub attachment_enrichment: AttachmentEnrichmentConfig,
    #[serde(default)]
    pub companion: CompanionConfig,
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
            model_providers: Vec::new(),
            active_provider_id: None,
            agent_profile_registry: crate::provider_profiles::AgentProfileRegistry::default(),
            profile_registry_is_derived: false,
            profile_registry_validation_error: None,
            providers: Vec::new(),
            agent_defaults: AgentDefaults::default(),
            agent_configs: AgentConfigs::default(),
            compact_ai_output: false,
            default_open_target: default_open_target(),
            notifications: NotificationSettings::default(),
            git: GitSettingsConfig::default(),
            theme: Theme::System,
            attachment_enrichment: AttachmentEnrichmentConfig::default(),
            companion: CompanionConfig::default(),
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
        assert_eq!(config.notifications.sound, "ding");
    }

    #[test]
    fn old_config_json_deserializes_with_default_open_target() {
        let raw = serde_json::json!({
            "providers": [],
            "active_provider_id": null,
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert_eq!(config.default_open_target, "file_explorer");
    }

    #[test]
    fn old_config_json_deserializes_with_git_defaults() {
        let raw = serde_json::json!({
            "providers": [],
            "active_provider_id": null,
            "theme": "System"
        });

        let config: AppConfig = serde_json::from_value(raw).unwrap();

        assert_eq!(config.git.commit_instructions, "");
        assert_eq!(config.git.pull_request_instructions, "");
        assert_eq!(config.git.provider_id, None);
        assert_eq!(config.git.model, "");
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
        assert!(AppConfig::default().providers.is_empty());
    }
}
