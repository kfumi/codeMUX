use crate::model_providers::types::{ModelProvider, Protocol, ProtocolEndpoint, ProviderModel};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuiltinProviderTemplate {
    pub id: String,
    pub name: String,
    pub endpoints: Vec<ProtocolEndpoint>,
    pub models: Vec<ProviderModel>,
    pub default_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_provider_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_npm: Option<String>,
    /// When true, Codex should route openai_compatible traffic through the chat-compat proxy.
    #[serde(default)]
    pub default_codex_needs_proxy: bool,
}

fn model(id: &str, name: &str, input_modalities: Option<Vec<&str>>) -> ProviderModel {
    ProviderModel {
        id: id.to_string(),
        name: Some(name.to_string()),
        context_1m: None,
        context_window: None,
        max_input_tokens: None,
        max_output_tokens: None,
        input_modalities: input_modalities
            .map(|items| items.into_iter().map(str::to_string).collect()),
        supports_vision: None,
    }
}

fn endpoint(
    protocol: Protocol,
    base_url: &str,
    codex_needs_proxy: Option<bool>,
) -> ProtocolEndpoint {
    ProtocolEndpoint {
        protocol,
        base_url: base_url.to_string(),
        api_key_override: None,
        codex_needs_proxy,
    }
}

pub fn builtin_templates() -> Vec<BuiltinProviderTemplate> {
    vec![
        BuiltinProviderTemplate {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            endpoints: vec![endpoint(
                Protocol::Anthropic,
                "https://api.anthropic.com",
                None,
            )],
            models: vec![
                model(
                    "claude-sonnet-4-20250514",
                    "Claude Sonnet 4",
                    Some(vec!["text", "image"]),
                ),
                model(
                    "claude-opus-4-20250514",
                    "Claude Opus 4",
                    Some(vec!["text", "image"]),
                ),
            ],
            default_model: "claude-sonnet-4-20250514".to_string(),
            opencode_provider_key: None,
            opencode_npm: None,
            default_codex_needs_proxy: false,
        },
        BuiltinProviderTemplate {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            endpoints: vec![endpoint(
                Protocol::OpenaiCompatible,
                "https://api.openai.com/v1",
                Some(false),
            )],
            models: vec![
                model("gpt-5", "GPT-5", Some(vec!["text", "image"])),
                model("gpt-4.1", "GPT-4.1", Some(vec!["text", "image"])),
            ],
            default_model: "gpt-5".to_string(),
            opencode_provider_key: Some("openai".to_string()),
            opencode_npm: None,
            default_codex_needs_proxy: false,
        },
        BuiltinProviderTemplate {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            endpoints: vec![
                endpoint(
                    Protocol::Anthropic,
                    "https://api.deepseek.com/anthropic",
                    None,
                ),
                endpoint(
                    Protocol::OpenaiCompatible,
                    "https://api.deepseek.com",
                    Some(false),
                ),
            ],
            models: vec![
                model("deepseek-v4-flash", "DeepSeek V4 Flash", Some(vec!["text"])),
                model("deepseek-v4-pro", "DeepSeek V4 Pro", Some(vec!["text"])),
            ],
            default_model: "deepseek-v4-flash".to_string(),
            opencode_provider_key: Some("deepseek".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: false,
        },
        BuiltinProviderTemplate {
            id: "openrouter".to_string(),
            name: "OpenRouter".to_string(),
            endpoints: vec![
                endpoint(Protocol::Anthropic, "https://openrouter.ai/api/v1", None),
                endpoint(
                    Protocol::OpenaiCompatible,
                    "https://openrouter.ai/api/v1",
                    Some(true),
                ),
            ],
            models: vec![
                model(
                    "anthropic/claude-sonnet-4",
                    "Claude Sonnet 4",
                    Some(vec!["text", "image"]),
                ),
                model("openai/gpt-4.1", "GPT-4.1", Some(vec!["text", "image"])),
            ],
            default_model: "anthropic/claude-sonnet-4".to_string(),
            opencode_provider_key: Some("openrouter".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
        BuiltinProviderTemplate {
            id: "siliconflow".to_string(),
            name: "硅基流动".to_string(),
            endpoints: vec![endpoint(
                Protocol::OpenaiCompatible,
                "https://api.siliconflow.cn/v1",
                Some(true),
            )],
            models: vec![
                model(
                    "deepseek-ai/DeepSeek-V3",
                    "DeepSeek V3 0324",
                    Some(vec!["text"]),
                ),
                model("Qwen/Qwen2.5-72B-Instruct", "Qwen2.5 72B Instruct", None),
            ],
            default_model: "deepseek-ai/DeepSeek-V3".to_string(),
            opencode_provider_key: Some("siliconflow".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
        BuiltinProviderTemplate {
            id: "zhipu".to_string(),
            name: "智谱".to_string(),
            endpoints: vec![endpoint(
                Protocol::OpenaiCompatible,
                "https://open.bigmodel.cn/api/paas/v4",
                Some(true),
            )],
            models: vec![
                model("glm-4.7", "GLM-4.7", Some(vec!["text"])),
                model("glm-4.7-flash", "GLM-4.7-Flash", Some(vec!["text"])),
            ],
            default_model: "glm-4.7".to_string(),
            opencode_provider_key: Some("zhipu".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
        BuiltinProviderTemplate {
            id: "moonshot".to_string(),
            name: "月之暗面".to_string(),
            endpoints: vec![endpoint(
                Protocol::OpenaiCompatible,
                "https://api.moonshot.cn/v1",
                Some(true),
            )],
            models: vec![
                model("kimi-k2.6", "Kimi K2.6", Some(vec!["text"])),
                model("kimi-k3", "Kimi K3", Some(vec!["text"])),
            ],
            default_model: "kimi-k2.6".to_string(),
            opencode_provider_key: Some("moonshot".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
        BuiltinProviderTemplate {
            id: "mimo".to_string(),
            name: "Xiaomi MiMo".to_string(),
            endpoints: vec![endpoint(
                Protocol::OpenaiCompatible,
                "https://api.xiaomimimo.com/v1",
                Some(true),
            )],
            models: vec![
                model("mimo-m2.5", "MiMo V2.5", Some(vec!["text"])),
                model("mimo-v2.5-pro", "MiMo V2.5 Pro", Some(vec!["text"])),
                model(
                    "mimo-v2.5-pro-ultraspeed",
                    "MiMo-V2.5-Pro-UltraSpeed",
                    Some(vec!["text"]),
                ),
            ],
            default_model: "mimo-m2.5".to_string(),
            opencode_provider_key: Some("mimo".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
        BuiltinProviderTemplate {
            id: "opencode-go".to_string(),
            name: "OpenCode Go".to_string(),
            endpoints: vec![
                endpoint(Protocol::Anthropic, "https://opencode.ai/zen/go", None),
                endpoint(
                    Protocol::OpenaiCompatible,
                    "https://opencode.ai/zen/go/v1",
                    Some(true),
                ),
            ],
            models: vec![
                model("deepseek-v4-flash", "DeepSeek V4 Flash", Some(vec!["text"])),
                model("kimi-k2.6", "Kimi K2.6", None),
                model("glm-5.1", "GLM-5.1", None),
            ],
            default_model: "deepseek-v4-flash".to_string(),
            opencode_provider_key: Some("opencode-go".to_string()),
            opencode_npm: Some("@ai-sdk/openai-compatible".to_string()),
            default_codex_needs_proxy: true,
        },
    ]
}

/// Instantiates a built-in template into a concrete Model Provider (empty API key).
pub fn instantiate_template(
    template_id: &str,
    provider_id: String,
) -> Result<ModelProvider, String> {
    let template = builtin_templates()
        .into_iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| format!("未知的内置供应商模板: {template_id}"))?;

    let endpoints = template
        .endpoints
        .into_iter()
        .map(|mut endpoint| {
            if endpoint.protocol == Protocol::OpenaiCompatible
                && endpoint.codex_needs_proxy.is_none()
            {
                endpoint.codex_needs_proxy = Some(template.default_codex_needs_proxy);
            }
            endpoint
        })
        .collect();

    Ok(ModelProvider {
        id: provider_id,
        name: template.name,
        enabled: false,
        api_key: String::new(),
        api_key_configured: false,
        endpoints,
        // Configured model list starts empty; template.models is the builtin catalog for the picker.
        models: Vec::new(),
        default_model: String::new(),
        builtin_template_id: Some(template.id),
        opencode_provider_key: template.opencode_provider_key,
        opencode_npm: template.opencode_npm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::types::AgentKind;
    use crate::model_providers::types::is_provider_usable;

    #[test]
    fn builtin_catalog_contains_agreed_templates() {
        let ids: Vec<_> = builtin_templates()
            .into_iter()
            .map(|item| item.id)
            .collect();
        for expected in [
            "anthropic",
            "openai",
            "deepseek",
            "openrouter",
            "siliconflow",
            "zhipu",
            "moonshot",
            "mimo",
            "opencode-go",
        ] {
            assert!(ids.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn deepseek_template_instance_starts_with_empty_models() {
        let provider = instantiate_template("deepseek", "id-1".to_string()).unwrap();
        assert!(provider.models.is_empty());
        assert!(provider.default_model.is_empty());
        assert!(!is_provider_usable(&provider, AgentKind::ClaudeCode));
    }

    #[test]
    fn deepseek_codex_endpoint_defaults_to_direct_responses() {
        let template = builtin_templates()
            .into_iter()
            .find(|item| item.id == "deepseek")
            .unwrap();

        let endpoint = template
            .endpoints
            .iter()
            .find(|item| item.protocol == Protocol::OpenaiCompatible)
            .unwrap();

        assert_eq!(endpoint.codex_needs_proxy, Some(false));
        assert!(!template.default_codex_needs_proxy);
    }

    #[test]
    fn deepseek_template_instance_usable_after_key_and_models() {
        let template = builtin_templates()
            .into_iter()
            .find(|item| item.id == "deepseek")
            .unwrap();
        let mut provider = instantiate_template("deepseek", "id-1".to_string()).unwrap();
        provider.enabled = true;
        provider.api_key = "sk-test".to_string();
        provider.models = template.models;
        provider.default_model = template.default_model;
        assert!(is_provider_usable(&provider, AgentKind::ClaudeCode));
        assert!(is_provider_usable(&provider, AgentKind::Codex));
    }

    #[test]
    fn opencode_go_is_not_agent_kind_opencode() {
        let provider = instantiate_template("opencode-go", "id-go".to_string()).unwrap();
        assert_eq!(provider.builtin_template_id.as_deref(), Some("opencode-go"));
        assert_eq!(provider.name, "OpenCode Go");
    }
}
