use crate::config::types::AgentKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Anthropic,
    OpenaiCompatible,
    OpenaiResponses,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenaiCompatible => "openai_compatible",
            Self::OpenaiResponses => "openai_responses",
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
    /// Claude Code: append `[1m]` to the request model id for 1M context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_1m: Option<bool>,
    /// Codex / OpenCode context window metadata (tokens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// OpenCode `limit.input` (tokens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u64>,
    /// OpenCode `limit.output` (tokens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_vision: Option<bool>,
    /// 用户声明的「模型原生支持思考/推理」。
    ///
    /// 目前只有 pi 消费它：pi 从托管 `models.json` 读模型条目，条目缺
    /// `reasoning` 时（pi 默认 `definition.reasoning ?? false`）它会认为该模型
    /// 不支持思考，把任何思考档位钳回 `off`，且不向供应商发送思考参数。只有
    /// `Some(true)` 才向 pi 声明支持；`None`/`Some(false)` 一律不声明（保持
    /// `off`），避免对非推理模型发出无效的 thinking 参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
}

/// Strip Claude Code `[1m]` context markers from a model id (case-insensitive).
pub fn strip_context_1m_suffix(model: &str) -> String {
    let mut value = model.trim().to_string();
    loop {
        let lower = value.to_ascii_lowercase();
        let Some(index) = lower.find("[1m]") else {
            break;
        };
        value = format!("{}{}", &value[..index], &value[index + 4..]);
    }
    value.trim().to_string()
}

/// Ensure a bare model id carries the Claude Code `[1m]` suffix.
pub fn with_context_1m_suffix(model: &str) -> String {
    let base = strip_context_1m_suffix(model);
    if base.is_empty() {
        return base;
    }
    format!("{base}[1m]")
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub api_key: String,
    /// Frontend-only: true when a non-empty key exists but was redacted from `api_key`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub api_key_configured: bool,
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
        // pi 双协议都可用；主协议取 Anthropic（凭据经 ANTHROPIC_* 注入），
        // 端点选择时回退 OpenAI 兼容。
        AgentKind::Pi => Some(Protocol::Anthropic),
        AgentKind::GeminiCli => None,
    }
}

pub fn select_endpoint(provider: &ModelProvider, protocol: Protocol) -> Option<&ProtocolEndpoint> {
    provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.protocol == protocol && !endpoint.base_url.trim().is_empty())
}

/// Picks the endpoint an agent kind should dial.
///
/// Codex prefers a native Responses endpoint (`openai_responses`) when one is
/// configured and falls back to the chat-completions endpoint; the other agent
/// kinds keep their single required protocol.
pub fn select_agent_endpoint(
    provider: &ModelProvider,
    agent_kind: AgentKind,
) -> Option<&ProtocolEndpoint> {
    match agent_kind {
        AgentKind::Codex => select_endpoint(provider, Protocol::OpenaiResponses)
            .or_else(|| select_endpoint(provider, Protocol::OpenaiCompatible)),
        AgentKind::Pi => select_endpoint(provider, Protocol::Anthropic)
            .or_else(|| select_endpoint(provider, Protocol::OpenaiCompatible)),
        other => {
            let protocol = required_protocol(other)?;
            select_endpoint(provider, protocol)
        }
    }
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
    let Some(endpoint) = select_agent_endpoint(provider, agent_kind) else {
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

/// Soft validation for save: identity + at least one endpoint. API key optional.
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
    if !default_model.is_empty()
        && !provider.models.is_empty()
        && !provider
            .models
            .iter()
            .any(|model| model.id.trim() == default_model)
    {
        return Err("默认模型必须存在于模型列表中".to_string());
    }
    Ok(())
}

/// Strict validation when enabling a provider: key, models, and default model required.
pub fn validate_provider_for_enable(provider: &ModelProvider) -> Result<(), String> {
    validate_provider(provider)?;
    let has_key = !provider.api_key.trim().is_empty()
        || provider.endpoints.iter().any(|endpoint| {
            endpoint
                .api_key_override
                .as_deref()
                .is_some_and(|key| !key.trim().is_empty())
        });
    if !has_key {
        return Err("启用前请先填写 API Key".to_string());
    }
    if provider.models.is_empty() {
        return Err("启用前请至少添加一个模型".to_string());
    }
    let default_model = provider.default_model.trim();
    if default_model.is_empty() {
        return Err("启用前请选择默认模型".to_string());
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
                codex_needs_proxy: Some(false),
            });
        }
        ModelProvider {
            id: "deepseek-1".to_string(),
            name: "DeepSeek".to_string(),
            enabled: true,
            api_key: "sk-test".to_string(),
            api_key_configured: false,
            endpoints,
            models: vec![ProviderModel {
                id: "deepseek-v4-flash".to_string(),
                name: Some("DeepSeek V4 Flash".to_string()),
                context_1m: None,
                context_window: None,
                max_input_tokens: None,
                max_output_tokens: None,
                supports_reasoning: None,
                supports_vision: None,
                input_modalities: None,
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
    fn validate_provider_allows_empty_api_key_on_save() {
        let mut provider = deepseek_provider(true, true);
        provider.api_key.clear();
        assert!(validate_provider(&provider).is_ok());
    }

    #[test]
    fn validate_provider_for_enable_requires_api_key() {
        let mut provider = deepseek_provider(true, true);
        provider.api_key.clear();
        assert!(validate_provider_for_enable(&provider).is_err());
    }

    #[test]
    fn validate_provider_requires_default_in_models_when_set() {
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

    #[test]
    fn openai_responses_serializes_as_snake_case() {
        assert_eq!(Protocol::OpenaiResponses.as_str(), "openai_responses");
        let endpoint = ProtocolEndpoint {
            protocol: Protocol::OpenaiResponses,
            base_url: "https://open.bigmodel.cn/api/v1".to_string(),
            api_key_override: None,
            codex_needs_proxy: Some(false),
        };
        let json = serde_json::to_value(&endpoint).unwrap();
        assert_eq!(json["protocol"], "openai_responses");
        let parsed: ProtocolEndpoint = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, endpoint);
    }

    #[test]
    fn codex_prefers_responses_endpoint_and_falls_back_to_chat() {
        let mut provider = deepseek_provider(true, true);
        assert_eq!(
            select_agent_endpoint(&provider, AgentKind::Codex).map(|endpoint| endpoint.protocol),
            Some(Protocol::OpenaiCompatible)
        );
        provider.endpoints.insert(
            0,
            ProtocolEndpoint {
                protocol: Protocol::OpenaiResponses,
                base_url: "https://open.bigmodel.cn/api/v1".to_string(),
                api_key_override: None,
                codex_needs_proxy: Some(false),
            },
        );
        assert_eq!(
            select_agent_endpoint(&provider, AgentKind::Codex).map(|endpoint| endpoint.protocol),
            Some(Protocol::OpenaiResponses)
        );
        assert_eq!(
            select_agent_endpoint(&provider, AgentKind::Opencode).map(|endpoint| endpoint.protocol),
            Some(Protocol::OpenaiCompatible)
        );
        assert_eq!(
            select_agent_endpoint(&provider, AgentKind::ClaudeCode)
                .map(|endpoint| endpoint.protocol),
            Some(Protocol::Anthropic)
        );
    }

    #[test]
    fn empty_responses_base_url_falls_back_to_chat() {
        let mut provider = deepseek_provider(true, true);
        provider.endpoints.push(ProtocolEndpoint {
            protocol: Protocol::OpenaiResponses,
            base_url: "  ".to_string(),
            api_key_override: None,
            codex_needs_proxy: Some(false),
        });
        assert_eq!(
            select_agent_endpoint(&provider, AgentKind::Codex).map(|endpoint| endpoint.protocol),
            Some(Protocol::OpenaiCompatible)
        );
    }

    #[test]
    fn responses_only_provider_is_usable_for_codex_but_not_opencode() {
        let mut provider = deepseek_provider(false, false);
        provider.endpoints.push(ProtocolEndpoint {
            protocol: Protocol::OpenaiResponses,
            base_url: "https://open.bigmodel.cn/api/v1".to_string(),
            api_key_override: None,
            codex_needs_proxy: Some(false),
        });
        assert!(is_provider_usable(&provider, AgentKind::Codex));
        assert!(!is_provider_usable(&provider, AgentKind::Opencode));
        assert!(!is_provider_usable(&provider, AgentKind::ClaudeCode));
    }

    #[test]
    fn strip_context_1m_suffix_removes_markers() {
        assert_eq!(
            strip_context_1m_suffix("deepseek-v4-flash[1m]"),
            "deepseek-v4-flash"
        );
        assert_eq!(
            strip_context_1m_suffix("deepseek-v4-flash[1M]"),
            "deepseek-v4-flash"
        );
        assert_eq!(
            with_context_1m_suffix("deepseek-v4-flash[1m]"),
            "deepseek-v4-flash[1m]"
        );
    }
}
