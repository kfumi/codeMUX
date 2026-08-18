use serde::Serialize;
use serde_json::Value;

use crate::config::types::{AgentConfigs, AgentDefaults, AgentKind};
#[cfg(test)]
use crate::model_providers::Protocol;
use crate::model_providers::{is_provider_usable, ModelProvider, ProviderModel};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileBootstrap {
    pub default_agent_kind: String,
    pub active_provider_id: Option<String>,
    pub compact_ai_output: bool,
    pub providers: Vec<MobileProvider>,
    pub agent_defaults: MobileAgentDefaults,
    pub reasoning_efforts: Vec<&'static str>,
    pub permission_presets: MobilePermissionPresets,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileProvider {
    pub id: String,
    pub name: String,
    pub template_id: Option<String>,
    pub enabled: bool,
    pub configured: bool,
    pub default_model: String,
    pub models: Vec<ProviderModel>,
    pub protocols: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAgentDefaults {
    pub claude_code: MobileAgentKindDefaults,
    pub codex: MobileAgentKindDefaults,
    pub opencode: MobileAgentKindDefaults,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAgentKindDefaults {
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePermissionPresets {
    pub claude_code: Value,
    pub codex: Value,
    pub opencode: Value,
}

pub fn build_mobile_bootstrap(state: &AppState) -> MobileBootstrap {
    let config = state.config.lock().expect("config lock poisoned");
    MobileBootstrap {
        default_agent_kind: config
            .agent_defaults
            .default_agent_kind
            .as_str()
            .to_string(),
        active_provider_id: config.active_provider_id.clone(),
        compact_ai_output: config.compact_ai_output,
        providers: config
            .model_providers
            .iter()
            .map(sanitize_provider)
            .collect(),
        agent_defaults: build_agent_defaults(&config.agent_defaults, &config.agent_configs),
        reasoning_efforts: vec!["none", "low", "medium", "high", "xhigh", "max"],
        permission_presets: build_permission_presets(&config.agent_configs),
    }
}

fn is_provider_configured(provider: &ModelProvider) -> bool {
    [AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::Opencode]
        .into_iter()
        .any(|kind| is_provider_usable(provider, kind))
}

fn sanitize_provider(provider: &ModelProvider) -> MobileProvider {
    let protocols = provider
        .endpoints
        .iter()
        .map(|endpoint| endpoint.protocol.as_str().to_string())
        .collect::<Vec<_>>();
    MobileProvider {
        id: provider.id.clone(),
        name: provider.name.clone(),
        template_id: provider.builtin_template_id.clone(),
        enabled: provider.enabled,
        configured: is_provider_configured(provider),
        default_model: provider.default_model.clone(),
        models: provider.models.clone(),
        protocols,
    }
}

fn build_agent_defaults(_defaults: &AgentDefaults, configs: &AgentConfigs) -> MobileAgentDefaults {
    MobileAgentDefaults {
        claude_code: MobileAgentKindDefaults {
            provider_id: configs.claude_code.default_provider_id.clone(),
            model: configs.claude_code.default_model.clone(),
        },
        codex: MobileAgentKindDefaults {
            provider_id: configs.codex.default_provider_id.clone(),
            model: configs.codex.default_model.clone(),
        },
        opencode: MobileAgentKindDefaults {
            provider_id: configs.opencode.default_provider_id.clone(),
            model: configs.opencode.default_model.clone(),
        },
    }
}

fn build_permission_presets(configs: &AgentConfigs) -> MobilePermissionPresets {
    MobilePermissionPresets {
        claude_code: serde_json::to_value(&configs.claude_code.permission_config)
            .unwrap_or(Value::Object(Default::default())),
        codex: serde_json::to_value(&configs.codex.permission_config)
            .unwrap_or(Value::Object(Default::default())),
        opencode: serde_json::json!({
            "permissionMode": "full_access"
        }),
    }
}

#[cfg(test)]
pub fn provider_supports_agent(provider: &MobileProvider, agent_kind: AgentKind) -> bool {
    let required = match agent_kind {
        AgentKind::ClaudeCode => Protocol::Anthropic,
        AgentKind::Codex | AgentKind::Opencode => Protocol::OpenaiCompatible,
        AgentKind::GeminiCli => return false,
    };
    provider.enabled
        && provider.configured
        && provider
            .protocols
            .iter()
            .any(|protocol| protocol == required.as_str())
}

#[cfg(test)]
mod tests {
    use super::{provider_supports_agent, MobileProvider};
    use crate::config::types::AgentKind;

    #[test]
    fn filters_provider_by_protocol() {
        let provider = MobileProvider {
            id: "p1".to_string(),
            name: "Anthropic".to_string(),
            template_id: None,
            enabled: true,
            configured: true,
            default_model: "sonnet".to_string(),
            models: vec![],
            protocols: vec!["anthropic".to_string()],
        };
        assert!(provider_supports_agent(&provider, AgentKind::ClaudeCode));
        assert!(!provider_supports_agent(&provider, AgentKind::Codex));
    }
}
