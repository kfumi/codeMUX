use crate::config::types::{AgentKind, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

const MIGRATION_REVIEW_NOTE: &str = "需要检查原生高级配置";

#[derive(Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeProfileConfig {
    ClaudeCode {
        settings: Value,
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
                settings: _,
                requires_review,
            } => formatter
                .debug_struct("ClaudeCode")
                .field("settings", &"[已脱敏]")
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

impl NativeProfileConfig {
    pub fn claude_settings(&self) -> Option<&Value> {
        match self {
            Self::ClaudeCode { settings, .. } => Some(settings),
            _ => None,
        }
    }

    pub fn claude_env_value(&self, key: &str) -> Option<&str> {
        self.claude_settings()?
            .get("env")?
            .as_object()?
            .get(key)?
            .as_str()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum NativeProfileConfigRaw {
    ClaudeCode {
        #[serde(default)]
        settings: Option<Value>,
        #[serde(default)]
        api_key: String,
        #[serde(default)]
        anthropic_base_url: String,
        #[serde(default)]
        context_1m: Option<bool>,
        #[serde(default)]
        advanced_config: Option<Value>,
        #[serde(default)]
        requires_review: bool,
    },
    Codex {
        api_key: String,
        openai_base_url: String,
        #[serde(default)]
        codex_needs_proxy: Option<bool>,
        #[serde(default)]
        advanced_config: Option<Value>,
        #[serde(default)]
        requires_review: bool,
    },
    #[serde(rename = "opencode")]
    OpenCode {
        api_key: String,
        openai_base_url: String,
        #[serde(default)]
        advanced_config: Option<Value>,
        #[serde(default)]
        requires_review: bool,
    },
}

fn deserialize_native_profile_config(
    value: Value,
    default_model: &str,
) -> Result<NativeProfileConfig, String> {
    let raw: NativeProfileConfigRaw =
        serde_json::from_value(value).map_err(|error| format!("原生档案配置无效: {}", error))?;

    Ok(match raw {
        NativeProfileConfigRaw::ClaudeCode {
            settings: Some(settings),
            requires_review,
            ..
        } => NativeProfileConfig::ClaudeCode {
            settings,
            requires_review,
        },
        NativeProfileConfigRaw::ClaudeCode {
            api_key,
            anthropic_base_url,
            context_1m,
            advanced_config,
            requires_review,
            ..
        } => NativeProfileConfig::ClaudeCode {
            settings: legacy_claude_settings(
                &api_key,
                &anthropic_base_url,
                context_1m.unwrap_or(false),
                advanced_config.as_ref(),
                default_model,
            ),
            requires_review,
        },
        NativeProfileConfigRaw::Codex {
            api_key,
            openai_base_url,
            codex_needs_proxy,
            advanced_config,
            requires_review,
        } => NativeProfileConfig::Codex {
            api_key,
            openai_base_url,
            codex_needs_proxy,
            advanced_config,
            requires_review,
        },
        NativeProfileConfigRaw::OpenCode {
            api_key,
            openai_base_url,
            advanced_config,
            requires_review,
        } => NativeProfileConfig::OpenCode {
            api_key,
            openai_base_url,
            advanced_config,
            requires_review,
        },
    })
}

impl<'de> Deserialize<'de> for NativeProfileConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserialize_native_profile_config(Value::deserialize(deserializer)?, "")
            .map_err(serde::de::Error::custom)
    }
}

fn legacy_claude_settings(
    api_key: &str,
    base_url: &str,
    context_1m: bool,
    advanced_config: Option<&Value>,
    default_model: &str,
) -> Value {
    let mut settings = serde_json::json!({
        "env": {},
        "theme": "auto",
        "includeCoAuthoredBy": false,
        "autoUpdatesChannel": "latest",
    });
    if let Some(advanced) = advanced_config.and_then(Value::as_object) {
        deep_merge_json_objects(
            settings.as_object_mut().expect("默认设置必须为对象"),
            advanced,
        );
    }

    let env = settings
        .as_object_mut()
        .expect("默认设置必须为对象")
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()));
    if !env.is_object() {
        *env = Value::Object(Map::new());
    }
    let env = env.as_object_mut().expect("env 已规范化为对象");
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        Value::String(api_key.to_string()),
    );
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        Value::String(base_url.to_string()),
    );
    if !default_model.trim().is_empty() {
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            Value::String(default_model.to_string()),
        );
        env.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
            Value::String(default_model.to_string()),
        );
        let role_model = if context_1m {
            format!("{}[1M]", default_model)
        } else {
            default_model.to_string()
        };
        for key in [
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            env.insert(key.to_string(), Value::String(role_model.clone()));
        }
    }
    settings
}

fn deep_merge_json_objects(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, source_value) in source {
        match (target.get_mut(key), source_value) {
            (Some(Value::Object(target_value)), Value::Object(source_value)) => {
                deep_merge_json_objects(target_value, source_value);
            }
            _ => {
                target.insert(key.clone(), source_value.clone());
            }
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

#[derive(Debug, Clone, Serialize, PartialEq)]
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

#[derive(Deserialize)]
struct AgentProviderProfileRaw {
    id: String,
    agent_kind: AgentKind,
    name: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    models: Vec<ProfileModel>,
    default_model: String,
    native_config: Value,
}

impl<'de> Deserialize<'de> for AgentProviderProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = AgentProviderProfileRaw::deserialize(deserializer)?;
        let native_config =
            deserialize_native_profile_config(raw.native_config, &raw.default_model)
                .map_err(serde::de::Error::custom)?;
        Ok(Self {
            id: raw.id,
            agent_kind: raw.agent_kind,
            name: raw.name,
            note: raw.note,
            models: raw.models,
            default_model: raw.default_model,
            native_config,
        })
    }
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
            if self.models.is_empty() {
                if self.default_model.is_empty() {
                    Ok(())
                } else {
                    Err("模型列表为空时默认模型必须为空".to_string())
                }
            } else if self.default_model.is_empty()
                || !self
                    .models
                    .iter()
                    .any(|model| model.id == self.default_model)
            {
                Err("默认模型必须属于档案的模型列表".to_string())
            } else {
                Ok(())
            }
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
            let matching_profile = self
                .profiles
                .iter()
                .find(|profile| profile.agent_kind == *agent_kind && profile.id == *profile_id);
            let Some(profile) = matching_profile else {
                return Err("启用档案与智能体类型不匹配".to_string());
            };
            if profile.default_model.trim().is_empty() {
                return Err("启用档案必须配置默认模型".to_string());
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
        let models = legacy_profile_models(provider);
        let default_model = legacy_default_model(provider, &models);

        if !provider.anthropic_base_url.trim().is_empty() {
            let profile = AgentProviderProfile {
                id: legacy_profile_id(provider, AgentKind::ClaudeCode),
                agent_kind: AgentKind::ClaudeCode,
                name: provider.name.clone(),
                note: MIGRATION_REVIEW_NOTE.to_string(),
                models: models.clone(),
                default_model: default_model.clone(),
                native_config: NativeProfileConfig::ClaudeCode {
                    settings: legacy_claude_settings(
                        &provider.api_key,
                        &provider.anthropic_base_url,
                        provider.context_1m.unwrap_or(false),
                        None,
                        &default_model,
                    ),
                    requires_review: true,
                },
            };
            add_migrated_profile(&mut registry, profile, false)?;
        }

        if !provider.openai_base_url.trim().is_empty() {
            let codex_profile = AgentProviderProfile {
                id: legacy_profile_id(provider, AgentKind::Codex),
                agent_kind: AgentKind::Codex,
                name: provider.name.clone(),
                note: MIGRATION_REVIEW_NOTE.to_string(),
                models: models.clone(),
                default_model: default_model.clone(),
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
                models: models.clone(),
                default_model: default_model.clone(),
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
        if profile.agent_kind != AgentKind::ClaudeCode && !profile.default_model.trim().is_empty() {
            registry
                .active_profile_ids
                .entry(profile.agent_kind)
                .or_insert_with(|| profile.id.clone());
        }
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
    let mut models: Vec<ProfileModel> = provider
        .models
        .iter()
        .map(|model| ProfileModel::from_legacy_model(model))
        .collect();

    if !provider.default_model.is_empty()
        && !models
            .iter()
            .any(|model| model.id == provider.default_model)
    {
        models.push(ProfileModel::from_legacy_model(&provider.default_model));
    }

    models
}

fn legacy_default_model(provider: &Provider, models: &[ProfileModel]) -> String {
    if models.is_empty() {
        String::new()
    } else if provider.default_model.is_empty() {
        models[0].id.clone()
    } else {
        provider.default_model.clone()
    }
}

fn set_active_profile_if_needed(
    registry: &mut AgentProfileRegistry,
    agent_kind: AgentKind,
    profile_id: &str,
    is_active: bool,
    has_default_model: bool,
) {
    if is_active && has_default_model {
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

    set_active_profile_if_needed(
        registry,
        profile.agent_kind,
        &profile.id,
        is_active,
        !profile.default_model.trim().is_empty(),
    );
    registry.profiles.push(profile);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        migrate_legacy_providers, AgentProfileRegistry, AgentProviderProfile, NativeProfileConfig,
        ProfileModel,
    };
    use crate::config::types::{AgentKind, Provider};

    fn legacy_provider() -> Provider {
        Provider {
            id: "legacy".to_string(),
            name: "旧供应商".to_string(),
            api_key: "legacy-token".to_string(),
            anthropic_base_url: "https://claude.example.test".to_string(),
            openai_base_url: "https://openai.example.test/v1".to_string(),
            default_model: "legacy-model".to_string(),
            models: vec!["legacy-model".to_string()],
            context_1m: Some(true),
            codex_needs_proxy: None,
        }
    }

    #[test]
    fn 旧版_claude_档案会规范化为完整_settings_json() {
        let profile: AgentProviderProfile = serde_json::from_value(serde_json::json!({
            "id": "claude",
            "agent_kind": "claude_code",
            "name": "旧 Claude 档案",
            "models": [{ "id": "legacy-model" }],
            "default_model": "legacy-model",
            "native_config": {
                "type": "claude_code",
                "api_key": "legacy-token",
                "anthropic_base_url": "https://claude.example.test",
                "context_1m": true,
                "advanced_config": {
                    "env": { "KEEP": "保留" },
                    "permissions": { "allow": ["Bash"] }
                }
            }
        }))
        .unwrap();

        let config = serde_json::to_value(profile.native_config).unwrap();

        assert_eq!(
            config["settings"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            "legacy-token"
        );
        assert_eq!(
            config["settings"]["env"]["ANTHROPIC_BASE_URL"],
            "https://claude.example.test"
        );
        assert_eq!(config["settings"]["env"]["ANTHROPIC_MODEL"], "legacy-model");
        assert_eq!(
            config["settings"]["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            "legacy-model"
        );
        for key in [
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            assert_eq!(config["settings"]["env"][key], "legacy-model[1M]");
        }
        assert_eq!(config["settings"]["env"]["KEEP"], "保留");
        assert_eq!(
            config["settings"]["permissions"]["allow"],
            serde_json::json!(["Bash"])
        );
        assert_eq!(config["settings"]["theme"], "auto");
        assert_eq!(config["settings"]["includeCoAuthoredBy"], false);
        assert_eq!(config["settings"]["autoUpdatesChannel"], "latest");
        assert!(config.get("api_key").is_none());
    }

    #[test]
    fn 旧供应商迁移不设置_claude_活动档案且保留其他智能体活动档案() {
        let registry = migrate_legacy_providers(&[legacy_provider()], Some("legacy"))
            .unwrap()
            .unwrap();

        assert!(!registry
            .active_profile_ids
            .contains_key(&AgentKind::ClaudeCode));
        assert_eq!(
            registry.active_profile_ids.get(&AgentKind::Codex),
            Some(&"legacy-codex".to_string())
        );
        assert_eq!(
            registry.active_profile_ids.get(&AgentKind::Opencode),
            Some(&"legacy-opencode".to_string())
        );
    }

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

    #[test]
    fn rejects_an_active_profile_without_a_default_model() {
        let profile = AgentProviderProfile {
            id: "empty-model".to_string(),
            agent_kind: AgentKind::Codex,
            name: "空模型档案".to_string(),
            note: String::new(),
            models: Vec::new(),
            default_model: String::new(),
            native_config: NativeProfileConfig::Codex {
                api_key: String::new(),
                openai_base_url: String::new(),
                codex_needs_proxy: None,
                advanced_config: None,
                requires_review: true,
            },
        };
        let registry = AgentProfileRegistry {
            profiles: vec![profile],
            active_profile_ids: BTreeMap::from([(AgentKind::Codex, "empty-model".to_string())]),
        };

        assert_eq!(registry.validate().unwrap_err(), "启用档案必须配置默认模型");
    }
}
