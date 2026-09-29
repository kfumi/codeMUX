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

/// `Default` 只为测试夹具与增量构造服务：`id` 会是空串，真实模型必须显式
/// 给出 id（`validate_provider` 会拒绝空 id）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    /// 思考档位白名单（CodeMUX 词表，见 [`THINKING_LEVELS`]）。
    ///
    /// `None` = 未声明（目录未命中且用户未配置）；`Some([])` = 用户明确
    /// 声明不支持；`Some([..])` = 支持，且精确列出开放哪几档。
    ///
    /// 这是 pi 声明 `reasoning` 的唯一依据：pi 从托管 `models.json` 读模型
    /// 条目，条目缺 `reasoning` 时（pi 默认 `definition.reasoning ?? false`）
    /// 它会认为该模型不支持思考，把任何思考档位钳回 `off`，且不向供应商发送
    /// 思考参数。空或未声明一律不写 `reasoning`，避免对非推理模型发出无效的
    /// thinking 参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
    /// @deprecated 已被 [`ProviderModel::thinking_levels`] 取代，仅为读取旧
    /// 配置保留。加载时由 `normalize_legacy_thinking_levels` 折叠进
    /// `thinking_levels` 后不再有读取方。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
}

/// CodeMUX 内部的思考档位词表，与 `src/lib/reasoningEffort.ts` 的
/// `ReasoningEffort` 逐一对应。
///
/// pi 自身的词表多一档 `minimal`（`EXTENDED_THINKING_LEVELS`，pi-ai
/// `dist/models.js`），但本项目从未把它暴露给用户，故不可达、不列入。
/// 两者的映射见 [`pi_thinking_level`]。
pub const THINKING_LEVELS: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

/// 把一个外部档位名折叠进 CodeMUX 词表。`off` / `disabled` 归到 `none`，
/// `minimal` 归到 `low`，其余按不区分大小写匹配；无法识别返回 `None`。
fn coerce_thinking_level(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" | "off" | "disabled" => Some("none"),
        "low" | "minimal" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// 归一化一份档位白名单：丢弃无法识别的项、去重，并按 [`THINKING_LEVELS`]
/// 的固定顺序返回，使写进 pi `models.json` 的 `thinkingLevelMap` 与会话里
/// 展示的顺序一致（也保证同一份配置反复保存得到逐字节相同的文件）。
pub fn normalize_thinking_levels(raw: &[String]) -> Vec<&'static str> {
    let coerced: Vec<&'static str> = raw
        .iter()
        .filter_map(|value| coerce_thinking_level(value))
        .collect();
    THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| coerced.contains(level))
        .collect()
}

/// CodeMUX 档位 → pi 词表名。`none → off`，其余同名。
pub fn pi_thinking_level(level: &str) -> Option<&'static str> {
    match coerce_thinking_level(level)? {
        "none" => Some("off"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// 该模型应当向 pi 声明的思考档位白名单（已归一化）。
///
/// 返回 `None` 表示**不向 pi 声明** `reasoning`——此时 pi 认为该模型不支持
/// 思考，把任何档位钳回 `off` 且不发送 thinking 参数。这正是我们对非推理
/// 模型想要的结果。
pub fn resolve_thinking_levels(model: &ProviderModel) -> Option<Vec<&'static str>> {
    let levels = normalize_thinking_levels(model.thinking_levels.as_deref().unwrap_or(&[]));
    (!levels.is_empty()).then_some(levels)
}

/// 折叠遗留的 `supports_reasoning` 布尔位进 `thinking_levels`，返回是否改动了配置。
///
/// `Some(true)` 展开为完整词表——这与该布尔位在世时的行为一致：老逻辑对任何
/// 声明支持的模型都无条件写 `thinkingLevelMap: {xhigh, max}`，于是 pi 开放它
/// 词表里的全部档位。`Some(false)` 与 `None` 同义（未声明），都归一为 `None`。
/// 已经带 `thinking_levels` 的模型只丢弃遗留位、不动新配置——但仍要清掉它，
/// 否则这个已废弃的字段会一直留在磁盘上的 `config.json` 里。
pub fn normalize_legacy_thinking_levels(provider: &mut ModelProvider) -> bool {
    let mut changed = false;
    for model in &mut provider.models {
        if model.supports_reasoning.is_none() {
            continue;
        }
        // 已有 thinking_levels 的模型只丢弃遗留位、不动新配置。
        if model.thinking_levels.is_none() && model.supports_reasoning == Some(true) {
            model.thinking_levels = Some(
                THINKING_LEVELS
                    .iter()
                    .map(|level| level.to_string())
                    .collect(),
            );
        }
        model.supports_reasoning = None;
        changed = true;
    }
    changed
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
                thinking_levels: None,
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

    fn levels(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|value| value.to_string()).collect()
    }

    fn provider_with_model(model: ProviderModel) -> ModelProvider {
        ModelProvider {
            id: "p".to_string(),
            name: "P".to_string(),
            enabled: true,
            api_key: String::new(),
            api_key_configured: false,
            endpoints: Vec::new(),
            models: vec![model],
            default_model: String::new(),
            builtin_template_id: None,
            opencode_provider_key: None,
            opencode_npm: None,
        }
    }

    #[test]
    fn normalize_thinking_levels_drops_unknown_dedupes_and_orders() {
        assert_eq!(
            normalize_thinking_levels(&levels(&["high", "high", "bogus", " ", "low"])).as_slice(),
            ["low", "high"]
        );
    }

    #[test]
    fn thinking_level_synonyms_fold_onto_canonical_names() {
        // pi 与会话历史会送来 off / minimal 等别名，归一化后必须落到同一档。
        assert_eq!(
            normalize_thinking_levels(&levels(&["off", "disabled", "minimal", "HIGH"])).as_slice(),
            ["none", "low", "high"]
        );
    }

    #[test]
    fn pi_thinking_level_maps_none_onto_off() {
        assert_eq!(pi_thinking_level("none"), Some("off"));
        assert_eq!(pi_thinking_level("xhigh"), Some("xhigh"));
        assert_eq!(pi_thinking_level("nope"), None);
    }

    #[test]
    fn resolve_thinking_levels_declares_nothing_when_unset_or_empty() {
        let mut model = ProviderModel {
            id: "m".to_string(),
            ..Default::default()
        };
        // 未声明：不给 pi 写 `reasoning`，pi 会把所有档位钳回 off 且不发 thinking 参数。
        assert_eq!(resolve_thinking_levels(&model), None);
        // 明确声明不支持：与未声明同样不写 `reasoning`。
        model.thinking_levels = Some(Vec::new());
        assert_eq!(resolve_thinking_levels(&model), None);
        // 只有空串/无法识别的项等同于未声明。
        model.thinking_levels = Some(levels(&["nope"]));
        assert_eq!(resolve_thinking_levels(&model), None);
    }

    #[test]
    fn resolve_thinking_levels_returns_normalized_whitelist() {
        let model = ProviderModel {
            id: "m".to_string(),
            thinking_levels: Some(levels(&["xhigh", "off", "high"])),
            ..Default::default()
        };
        assert_eq!(
            resolve_thinking_levels(&model).unwrap().as_slice(),
            ["none", "high", "xhigh"]
        );
    }

    #[test]
    fn legacy_supports_reasoning_true_expands_to_full_vocabulary() {
        let mut provider = provider_with_model(ProviderModel {
            id: "m".to_string(),
            supports_reasoning: Some(true),
            ..Default::default()
        });
        assert!(normalize_legacy_thinking_levels(&mut provider));
        let levels = provider.models[0].thinking_levels.as_ref().unwrap();
        assert_eq!(levels.len(), THINKING_LEVELS.len());
        for level in levels {
            assert!(THINKING_LEVELS.contains(&level.as_str()), "{level}");
        }
        assert_eq!(provider.models[0].supports_reasoning, None);
        // 迁移只发生一次：第二次调用不再报告改动。
        assert!(!normalize_legacy_thinking_levels(&mut provider));
    }

    #[test]
    fn legacy_supports_reasoning_false_becomes_unset() {
        let mut provider = provider_with_model(ProviderModel {
            id: "m".to_string(),
            supports_reasoning: Some(false),
            ..Default::default()
        });
        assert!(normalize_legacy_thinking_levels(&mut provider));
        assert_eq!(provider.models[0].thinking_levels, None);
        assert_eq!(provider.models[0].supports_reasoning, None);
    }

    #[test]
    fn legacy_normalization_never_overwrites_explicit_thinking_levels() {
        let explicit = Some(levels(&["low", "high"]));
        let mut provider = provider_with_model(ProviderModel {
            id: "m".to_string(),
            thinking_levels: explicit.clone(),
            supports_reasoning: Some(true),
            ..Default::default()
        });
        assert!(normalize_legacy_thinking_levels(&mut provider));
        assert_eq!(provider.models[0].thinking_levels, explicit);
    }
}
