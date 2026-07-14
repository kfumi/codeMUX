use crate::config::types::{AgentKind, Provider};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MIGRATION_REVIEW_NOTE: &str = "需要检查原生高级配置";

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeProfileConfig {
    ClaudeCode {
        api_key: String,
        anthropic_base_url: String,
        #[serde(default)]
        context_1m: Option<bool>,
        #[serde(default)]
        advanced_config: Option<serde_json::Value>,
        #[serde(default)]
        requires_review: bool,
    },
    Codex {
        api_key: String,
        openai_base_url: String,
        #[serde(default)]
        codex_needs_proxy: Option<bool>,
        #[serde(default)]
        advanced_config: Option<serde_json::Value>,
        #[serde(default)]
        requires_review: bool,
    },
    #[serde(rename = "opencode")]
    OpenCode {
        api_key: String,
        openai_base_url: String,
        #[serde(default)]
        advanced_config: Option<serde_json::Value>,
        #[serde(default)]
        requires_review: bool,
    },
}

impl std::fmt::Debug for NativeProfileConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClaudeCode {
                anthropic_base_url,
                context_1m,
                advanced_config,
                requires_review,
                ..
            } => formatter
                .debug_struct("ClaudeCode")
                .field("api_key", &"[已脱敏]")
                .field("anthropic_base_url", anthropic_base_url)
                .field("context_1m", context_1m)
                .field(
                    "advanced_config",
                    &advanced_config.as_ref().map(|_| "[已脱敏]"),
                )
                .field("requires_review", requires_review)
                .finish(),
            Self::Codex {
                openai_base_url,
                codex_needs_proxy,
                advanced_config,
                requires_review,
                ..
            } => formatter
                .debug_struct("Codex")
                .field("api_key", &"[已脱敏]")
                .field("openai_base_url", openai_base_url)
                .field("codex_needs_proxy", codex_needs_proxy)
                .field(
                    "advanced_config",
                    &advanced_config.as_ref().map(|_| "[已脱敏]"),
                )
                .field("requires_review", requires_review)
                .finish(),
            Self::OpenCode {
                openai_base_url,
                advanced_config,
                requires_review,
                ..
            } => formatter
                .debug_struct("OpenCode")
                .field("api_key", &"[已脱敏]")
                .field("openai_base_url", openai_base_url)
                .field(
                    "advanced_config",
                    &advanced_config.as_ref().map(|_| "[已脱敏]"),
                )
                .field("requires_review", requires_review)
                .finish(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileModel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
}

impl ProfileModel {
    fn from_legacy_model(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: Some(id.to_string()),
            context_window: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentProviderProfile {
    pub id: String,
    pub agent_kind: AgentKind,
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub models: Vec<ProfileModel>,
    pub default_model: String,
    pub native_config: NativeProfileConfig,
}

impl AgentProviderProfile {
    pub fn validate(&self) -> Result<(), String> {
        let is_matching_config = matches!(
            (&self.agent_kind, &self.native_config),
            (
                AgentKind::ClaudeCode,
                NativeProfileConfig::ClaudeCode { .. }
            ) | (AgentKind::Codex, NativeProfileConfig::Codex { .. })
                | (AgentKind::Opencode, NativeProfileConfig::OpenCode { .. })
        );

        if is_matching_config {
            Ok(())
        } else {
            Err("档案智能体类型与原生配置类型不一致".to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AgentProfileRegistry {
    #[serde(default)]
    pub profiles: Vec<AgentProviderProfile>,
    #[serde(default)]
    pub active_profile_ids: BTreeMap<AgentKind, String>,
}

impl AgentProfileRegistry {
    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        for profile in &self.profiles {
            profile.validate()?;
        }

        for (agent_kind, profile_id) in &self.active_profile_ids {
            let is_matching_profile = self
                .profiles
                .iter()
                .any(|profile| profile.agent_kind == *agent_kind && profile.id == *profile_id);
            if !is_matching_profile {
                return Err("启用档案与智能体类型不匹配".to_string());
            }
        }

        Ok(())
    }
}

pub fn migrate_legacy_providers(
    providers: &[Provider],
    active_provider_id: Option<&str>,
) -> Result<Option<AgentProfileRegistry>, String> {
    let mut registry = AgentProfileRegistry::default();

    for provider in providers {
        let is_active = active_provider_id == Some(provider.id.as_str());

        if !provider.anthropic_base_url.trim().is_empty() {
            let profile = AgentProviderProfile {
                id: legacy_profile_id(provider, AgentKind::ClaudeCode),
                agent_kind: AgentKind::ClaudeCode,
                name: provider.name.clone(),
                note: MIGRATION_REVIEW_NOTE.to_string(),
                models: legacy_profile_models(provider),
                default_model: provider.default_model.clone(),
                native_config: NativeProfileConfig::ClaudeCode {
                    api_key: provider.api_key.clone(),
                    anthropic_base_url: provider.anthropic_base_url.clone(),
                    context_1m: provider.context_1m,
                    advanced_config: None,
                    requires_review: true,
                },
            };
            add_migrated_profile(&mut registry, profile, is_active)?;
        }

        if !provider.openai_base_url.trim().is_empty() {
            let codex_profile = AgentProviderProfile {
                id: legacy_profile_id(provider, AgentKind::Codex),
                agent_kind: AgentKind::Codex,
                name: provider.name.clone(),
                note: MIGRATION_REVIEW_NOTE.to_string(),
                models: legacy_profile_models(provider),
                default_model: provider.default_model.clone(),
                native_config: NativeProfileConfig::Codex {
                    api_key: provider.api_key.clone(),
                    openai_base_url: provider.openai_base_url.clone(),
                    codex_needs_proxy: provider.codex_needs_proxy,
                    advanced_config: None,
                    requires_review: true,
                },
            };
            add_migrated_profile(&mut registry, codex_profile, is_active)?;

            let opencode_profile = AgentProviderProfile {
                id: legacy_profile_id(provider, AgentKind::Opencode),
                agent_kind: AgentKind::Opencode,
                name: provider.name.clone(),
                note: MIGRATION_REVIEW_NOTE.to_string(),
                models: legacy_profile_models(provider),
                default_model: provider.default_model.clone(),
                native_config: NativeProfileConfig::OpenCode {
                    api_key: provider.api_key.clone(),
                    openai_base_url: provider.openai_base_url.clone(),
                    advanced_config: None,
                    requires_review: true,
                },
            };
            add_migrated_profile(&mut registry, opencode_profile, is_active)?;
        }
    }

    if registry.is_empty() {
        return Ok(None);
    }

    for profile in &registry.profiles {
        registry
            .active_profile_ids
            .entry(profile.agent_kind)
            .or_insert_with(|| profile.id.clone());
    }

    registry
        .validate()
        .map_err(|error| format!("迁移生成的智能体供应商档案无效: {}", error))?;
    Ok(Some(registry))
}

fn legacy_profile_id(provider: &Provider, agent_kind: AgentKind) -> String {
    format!("{}-{}", provider.id, agent_kind.as_str())
}

fn legacy_profile_models(provider: &Provider) -> Vec<ProfileModel> {
    provider
        .models
        .iter()
        .map(|model| ProfileModel::from_legacy_model(model))
        .collect()
}

fn set_active_profile_if_needed(
    registry: &mut AgentProfileRegistry,
    agent_kind: AgentKind,
    profile_id: &str,
    is_active: bool,
) {
    if is_active {
        registry
            .active_profile_ids
            .insert(agent_kind, profile_id.to_string());
    }
}

fn add_migrated_profile(
    registry: &mut AgentProfileRegistry,
    profile: AgentProviderProfile,
    is_active: bool,
) -> Result<(), String> {
    profile
        .validate()
        .map_err(|error| format!("无法迁移供应商档案 {}: {}", profile.name, error))?;

    set_active_profile_if_needed(registry, profile.agent_kind, &profile.id, is_active);
    registry.profiles.push(profile);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AgentProviderProfile, NativeProfileConfig, ProfileModel};
    use crate::config::types::AgentKind;

    #[test]
    fn rejects_native_config_for_a_different_agent_kind() {
        let profile = AgentProviderProfile {
            id: "profile".to_string(),
            agent_kind: AgentKind::ClaudeCode,
            name: "不匹配档案".to_string(),
            note: String::new(),
            models: Vec::<ProfileModel>::new(),
            default_model: String::new(),
            native_config: NativeProfileConfig::Codex {
                api_key: String::new(),
                openai_base_url: String::new(),
                codex_needs_proxy: None,
                advanced_config: None,
                requires_review: true,
            },
        };

        assert_eq!(
            profile.validate().unwrap_err(),
            "档案智能体类型与原生配置类型不一致"
        );
    }
}
