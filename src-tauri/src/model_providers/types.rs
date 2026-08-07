use crate::config::types::AgentKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Anthropic,
    OpenaiCompatible,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenaiCompatible => "openai_compatible",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProtocolEndpoint {
    pub protocol: Protocol,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_needs_proxy: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub endpoints: Vec<ProtocolEndpoint>,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    #[serde(default)]
    pub default_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin_template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_provider_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_npm: Option<String>,
}

fn default_true() -> bool {
    true
}

impl std::fmt::Debug for ModelProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ModelProvider")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("enabled", &self.enabled)
            .field("api_key", &"[已脱敏]")
            .field("endpoints", &self.endpoints)
            .field("models", &self.models)
            .field("default_model", &self.default_model)
            .field("builtin_template_id", &self.builtin_template_id)
            .field("opencode_provider_key", &self.opencode_provider_key)
            .field("opencode_npm", &self.opencode_npm)
            .finish()
    }
}

/// Returns the protocol required by an agent kind for Model Provider resolution.
/// Gemini CLI and unknown kinds are out of scope for the first cut.
pub fn required_protocol(agent_kind: AgentKind) -> Option<Protocol> {
    match agent_kind {
        AgentKind::ClaudeCode => Some(Protocol::Anthropic),
        AgentKind::Codex | AgentKind::Opencode => Some(Protocol::OpenaiCompatible),
        AgentKind::GeminiCli => None,
    }
}

pub fn select_endpoint<'a>(
    provider: &'a ModelProvider,
    protocol: Protocol,
) -> Option<&'a ProtocolEndpoint> {
    provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.protocol == protocol && !endpoint.base_url.trim().is_empty())
}

pub fn effective_api_key(provider: &ModelProvider, endpoint: &ProtocolEndpoint) -> String {
    endpoint
        .api_key_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| provider.api_key.trim())
        .to_string()
}

pub fn is_provider_usable(provider: &ModelProvider, agent_kind: AgentKind) -> bool {
    if !provider.enabled {
        return false;
    }
    let Some(protocol) = required_protocol(agent_kind) else {
        return false;
    };
    let Some(endpoint) = select_endpoint(provider, protocol) else {
        return false;
    };
    if effective_api_key(provider, endpoint).is_empty() {
        return false;
    }
    let default_model = provider.default_model.trim();
    if default_model.is_empty() {
        return false;
    }
    provider
        .models
        .iter()
        .any(|model| model.id.trim() == default_model)
}

pub fn validate_provider(provider: &ModelProvider) -> Result<(), String> {
    if provider.id.trim().is_empty() {
        return Err("供应商 id 不能为空".to_string());
    }
    if provider.name.trim().is_empty() {
        return Err("供应商名称不能为空".to_string());
    }
    if provider.endpoints.is_empty() {
        return Err("至少需要一个协议端点".to_string());
    }
    for endpoint in &provider.endpoints {
        if endpoint.base_url.trim().is_empty() {
            return Err(format!(
                "协议端点 {} 的 base_url 不能为空",
                endpoint.protocol.as_str()
            ));
        }
    }
    let default_model = provider.default_model.trim();
    if default_model.is_empty() {
        return Err("默认模型不能为空".to_string());
    }
    if provider.models.is_empty() {
        return Err("至少需要一个模型".to_string());
    }
    if !provider
        .models
        .iter()
        .any(|model| model.id.trim() == default_model)
    {
        return Err("默认模型必须存在于模型列表中".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deepseek_provider(with_openai: bool, with_anthropic: bool) -> ModelProvider {
        let mut endpoints = Vec::new();
        if with_anthropic {
            endpoints.push(ProtocolEndpoint {
                protocol: Protocol::Anthropic,
                base_url: "https://api.deepseek.com/anthropic".to_string(),
                api_key_override: None,
                codex_needs_proxy: None,
            });
        }
        if with_openai {
            endpoints.push(ProtocolEndpoint {
                protocol: Protocol::OpenaiCompatible,
                base_url: "https://api.deepseek.com".to_string(),
                api_key_override: None,
                codex_needs_proxy: Some(true),
            });
        }
        ModelProvider {
            id: "deepseek-1".to_string(),
            name: "DeepSeek".to_string(),
            enabled: true,
            api_key: "sk-test".to_string(),
            endpoints,
            models: vec![ProviderModel {
                id: "deepseek-v4-flash".to_string(),
                name: Some("DeepSeek V4 Flash".to_string()),
            }],
            default_model: "deepseek-v4-flash".to_string(),
            builtin_template_id: Some("deepseek".to_string()),
            opencode_provider_key: None,
            opencode_npm: None,
        }
    }

    #[test]
    fn deepseek_with_both_endpoints_is_usable_for_claude_and_codex() {
        let provider = deepseek_provider(true, true);
        assert!(is_provider_usable(&provider, AgentKind::ClaudeCode));
        assert!(is_provider_usable(&provider, AgentKind::Codex));
        assert!(is_provider_usable(&provider, AgentKind::Opencode));
    }

    #[test]
    fn missing_openai_endpoint_blocks_codex() {
        let provider = deepseek_provider(false, true);
        assert!(is_provider_usable(&provider, AgentKind::ClaudeCode));
        assert!(!is_provider_usable(&provider, AgentKind::Codex));
    }

    #[test]
    fn empty_api_key_is_not_usable() {
        let mut provider = deepseek_provider(true, true);
        provider.api_key.clear();
        assert!(!is_provider_usable(&provider, AgentKind::ClaudeCode));
    }

    #[test]
    fn disabled_provider_is_not_usable() {
        let mut provider = deepseek_provider(true, true);
        provider.enabled = false;
        assert!(!is_provider_usable(&provider, AgentKind::ClaudeCode));
    }

    #[test]
    fn endpoint_api_key_override_can_unlock_provider() {
        let mut provider = deepseek_provider(true, true);
        provider.api_key.clear();
        provider.endpoints[0].api_key_override = Some("override-key".to_string());
        assert!(is_provider_usable(&provider, AgentKind::ClaudeCode));
        assert!(!is_provider_usable(&provider, AgentKind::Codex));
    }

    #[test]
    fn validate_provider_requires_default_in_models() {
        let mut provider = deepseek_provider(true, true);
        provider.default_model = "missing".to_string();
        assert!(validate_provider(&provider).is_err());
    }

    #[test]
    fn required_protocol_mapping() {
        assert_eq!(
            required_protocol(AgentKind::ClaudeCode),
            Some(Protocol::Anthropic)
        );
        assert_eq!(
            required_protocol(AgentKind::Codex),
            Some(Protocol::OpenaiCompatible)
        );
        assert_eq!(required_protocol(AgentKind::GeminiCli), None);
    }
}
