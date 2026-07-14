use crate::config::types::{AgentKind, Provider};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MIGRATION_REVIEW_NOTE: &str = "需要检查原生高级配置";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
}

pub fn migrate_legacy_providers(
    providers: &[Provider],
    active_provider_id: Option<&str>,
) -> Option<AgentProfileRegistry> {
    let mut registry = AgentProfileRegistry::default();

    for provider in providers {
        let is_active = active_provider_id == Some(provider.id.as_str());

        if !provider.anthropic_base_url.trim().is_empty() {
            let profile = AgentProviderProfile {
                id: uuid::Uuid::new_v4().to_string(),
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
            set_active_profile_if_needed(&mut registry, profile.agent_kind, &profile.id, is_active);
            registry.profiles.push(profile);
        }

        if !provider.openai_base_url.trim().is_empty() {
            let codex_profile = AgentProviderProfile {
                id: uuid::Uuid::new_v4().to_string(),
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
            set_active_profile_if_needed(
                &mut registry,
                codex_profile.agent_kind,
                &codex_profile.id,
                is_active,
            );
            registry.profiles.push(codex_profile);

            let opencode_profile = AgentProviderProfile {
                id: uuid::Uuid::new_v4().to_string(),
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
            set_active_profile_if_needed(
                &mut registry,
                opencode_profile.agent_kind,
                &opencode_profile.id,
                is_active,
            );
            registry.profiles.push(opencode_profile);
        }
    }

    if registry.is_empty() {
        return None;
    }

    for profile in &registry.profiles {
        registry
            .active_profile_ids
            .entry(profile.agent_kind)
            .or_insert_with(|| profile.id.clone());
    }

    Some(registry)
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
