use crate::provider_profiles::types::{AgentProviderProfile, NativeProfileConfig};
use serde_json::{Map, Value};
use std::path::PathBuf;
use toml_edit::{value, Array, DocumentMut, Item, Table, Value as TomlValue};

type JsonObject = Map<String, Value>;
type CodexAdvancedConfig<'a> = (Option<&'a JsonObject>, Option<&'a JsonObject>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigPaths {
    pub claude_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub opencode_dir: PathBuf,
}

impl NativeConfigPaths {
    pub fn new(claude_dir: PathBuf, codex_dir: PathBuf, opencode_dir: PathBuf) -> Self {
        Self {
            claude_dir,
            codex_dir,
            opencode_dir,
        }
    }

    pub fn claude_settings_path(&self) -> PathBuf {
        self.claude_dir.join("settings.json")
    }

    pub fn claude_settings_backup_path(&self) -> PathBuf {
        self.claude_dir.join("settings.json.bak")
    }

    pub fn codex_auth_path(&self) -> PathBuf {
        self.codex_dir.join("auth.json")
    }

    pub fn codex_config_path(&self) -> PathBuf {
        self.codex_dir.join("config.toml")
    }

    pub fn opencode_config_path(&self) -> PathBuf {
        self.opencode_dir.join("opencode.json")
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct NativeConfigContents {
    pub claude_settings: Option<String>,
    pub codex_auth: Option<String>,
    pub codex_config: Option<String>,
    pub opencode_config: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RenderedNativeConfig {
    pub path: PathBuf,
    pub content: String,
}

impl std::fmt::Debug for RenderedNativeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderedNativeConfig")
            .field("path", &self.path)
            .field("content", &"[已脱敏]")
            .finish()
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn render_native_config(
    paths: &NativeConfigPaths,
    profile: &NativeProfileConfig,
    existing: &NativeConfigContents,
) -> Result<Vec<RenderedNativeConfig>, String> {
    match profile {
        NativeProfileConfig::ClaudeCode { .. } => {
            let settings = parse_json_object(
                existing.claude_settings.as_deref(),
                "Claude Code settings.json",
            )?;
            let settings = merge_claude_settings(settings, profile)?;
            Ok(vec![render_json_file(
                paths.claude_settings_path(),
                settings,
                "Claude Code settings.json",
            )?])
        }
        NativeProfileConfig::Codex { .. } => {
            let auth = merge_codex_auth(
                parse_json_object(existing.codex_auth.as_deref(), "Codex auth.json")?,
                profile,
            )?;
            let config = merge_codex_config(
                parse_toml_document(existing.codex_config.as_deref(), "Codex config.toml")?,
                profile,
            )?;
            Ok(vec![
                render_json_file(paths.codex_auth_path(), auth, "Codex auth.json")?,
                render_toml_file(paths.codex_config_path(), config, "Codex config.toml")?,
            ])
        }
        NativeProfileConfig::OpenCode { .. } => {
            let config = merge_opencode_config(
                parse_json_object(
                    existing.opencode_config.as_deref(),
                    "OpenCode opencode.json",
                )?,
                profile,
            )?;
            Ok(vec![render_json_file(
                paths.opencode_config_path(),
                config,
                "OpenCode opencode.json",
            )?])
        }
    }
}

pub fn render_agent_profile_config(
    paths: &NativeConfigPaths,
    profile: &AgentProviderProfile,
    existing: &NativeConfigContents,
) -> Result<Vec<RenderedNativeConfig>, String> {
    profile.validate()?;
    let default_model =
        (!profile.default_model.trim().is_empty()).then_some(profile.default_model.as_str());

    match &profile.native_config {
        NativeProfileConfig::ClaudeCode { .. } => {
            let settings = parse_json_object(
                existing.claude_settings.as_deref(),
                "Claude Code settings.json",
            )?;
            let settings =
                merge_claude_settings_with_model(settings, &profile.native_config, default_model)?;
            Ok(vec![render_json_file(
                paths.claude_settings_path(),
                settings,
                "Claude Code settings.json",
            )?])
        }
        NativeProfileConfig::Codex { .. } => {
            let auth = merge_codex_auth(
                parse_json_object(existing.codex_auth.as_deref(), "Codex auth.json")?,
                &profile.native_config,
            )?;
            let config = merge_codex_config_with_model(
                parse_toml_document(existing.codex_config.as_deref(), "Codex config.toml")?,
                &profile.native_config,
                default_model,
            )?;
            Ok(vec![
                render_json_file(paths.codex_auth_path(), auth, "Codex auth.json")?,
                render_toml_file(paths.codex_config_path(), config, "Codex config.toml")?,
            ])
        }
        NativeProfileConfig::OpenCode { .. } => {
            let config = merge_opencode_config_with_model(
                parse_json_object(
                    existing.opencode_config.as_deref(),
                    "OpenCode opencode.json",
                )?,
                &profile.native_config,
                default_model,
            )?;
            Ok(vec![render_json_file(
                paths.opencode_config_path(),
                config,
                "OpenCode opencode.json",
            )?])
        }
    }
}

fn parse_json_object(content: Option<&str>, name: &str) -> Result<Value, String> {
    let value = match content.filter(|content| !content.trim().is_empty()) {
        Some(content) => serde_json::from_str(content).map_err(|_| format!("{} 配置无效", name))?,
        None => Value::Object(Map::new()),
    };
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} 顶层必须为对象", name))
    }
}

fn parse_toml_document(content: Option<&str>, name: &str) -> Result<DocumentMut, String> {
    match content.filter(|content| !content.trim().is_empty()) {
        Some(content) => content
            .parse::<DocumentMut>()
            .map_err(|_| format!("{} 配置无效", name)),
        None => Ok(DocumentMut::new()),
    }
}

fn render_json_file(
    path: PathBuf,
    value: Value,
    name: &str,
) -> Result<RenderedNativeConfig, String> {
    let content =
        serde_json::to_string_pretty(&value).map_err(|_| format!("{} 无法渲染", name))? + "\n";
    serde_json::from_str::<Value>(&content).map_err(|_| format!("{} 无法渲染", name))?;
    Ok(RenderedNativeConfig { path, content })
}

fn render_toml_file(
    path: PathBuf,
    document: DocumentMut,
    name: &str,
) -> Result<RenderedNativeConfig, String> {
    let content = document.to_string();
    content
        .parse::<DocumentMut>()
        .map_err(|_| format!("{} 无法渲染", name))?;
    Ok(RenderedNativeConfig { path, content })
}

fn merge_json_advanced_config(
    existing: Value,
    advanced_config: Option<&Value>,
    name: &str,
) -> Result<Value, String> {
    let Some(advanced_config) = advanced_config else {
        return Ok(existing);
    };
    let advanced = advanced_config
        .as_object()
        .ok_or_else(|| format!("{} advanced_config 必须为对象", name))?;
    merge_json_advanced_object(existing, Some(advanced), name)
}

fn merge_json_advanced_object(
    mut existing: Value,
    advanced_config: Option<&Map<String, Value>>,
    name: &str,
) -> Result<Value, String> {
    let Some(advanced) = advanced_config else {
        return Ok(existing);
    };
    let target = existing
        .as_object_mut()
        .ok_or_else(|| format!("{} 配置顶层必须为对象", name))?;
    merge_json_objects(target, advanced, name)?;
    Ok(existing)
}

fn merge_json_objects(
    target: &mut Map<String, Value>,
    advanced: &Map<String, Value>,
    name: &str,
) -> Result<(), String> {
    for (key, advanced_value) in advanced {
        let Some(existing_value) = target.get_mut(key) else {
            target.insert(key.clone(), advanced_value.clone());
            continue;
        };

        match (existing_value, advanced_value) {
            (Value::Object(existing), Value::Object(advanced)) => {
                merge_json_objects(existing, advanced, name)?;
            }
            (existing, advanced) if json_value_kind(existing) == json_value_kind(advanced) => {
                *existing = advanced.clone();
            }
            _ => return Err(format!("{} advanced_config 节点类型冲突", name)),
        }
    }
    Ok(())
}

pub fn merge_claude_settings_value(current: Value, supplier: Value) -> Result<Value, String> {
    let mut current = current;
    let supplier = supplier
        .as_object()
        .ok_or_else(|| "Claude Code settings 必须为对象".to_string())?;
    let target = current
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings 必须为对象".to_string())?;
    merge_json_objects(target, supplier, "Claude Code")?;
    Ok(current)
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn merge_claude_settings(
    existing: Value,
    profile: &NativeProfileConfig,
) -> Result<Value, String> {
    merge_claude_settings_with_model(existing, profile, None)
}

fn merge_claude_settings_with_model(
    existing: Value,
    profile: &NativeProfileConfig,
    _default_model: Option<&str>,
) -> Result<Value, String> {
    let Some(profile_settings) = profile.claude_settings() else {
        return Err("原生配置类型与 Claude Code 不匹配".to_string());
    };
    merge_claude_settings_value(existing, profile_settings.clone())
}

fn merge_codex_auth(mut existing: Value, profile: &NativeProfileConfig) -> Result<Value, String> {
    let NativeProfileConfig::Codex { api_key, .. } = profile else {
        return Err("原生配置类型与 Codex 不匹配".to_string());
    };
    let (auth_advanced, _) = codex_advanced_config(profile)?;
    existing = merge_json_advanced_object(existing, auth_advanced, "Codex auth.json")?;
    let auth = existing
        .as_object_mut()
        .ok_or_else(|| "Codex auth.json 顶层必须为对象".to_string())?;
    auth.insert("OPENAI_API_KEY".to_string(), Value::String(api_key.clone()));
    Ok(existing)
}

#[cfg_attr(not(test), allow(dead_code))]
fn merge_codex_config(
    existing: DocumentMut,
    profile: &NativeProfileConfig,
) -> Result<DocumentMut, String> {
    merge_codex_config_with_model(existing, profile, None)
}

fn merge_codex_config_with_model(
    mut existing: DocumentMut,
    profile: &NativeProfileConfig,
    default_model: Option<&str>,
) -> Result<DocumentMut, String> {
    let NativeProfileConfig::Codex {
        openai_base_url, ..
    } = profile
    else {
        return Err("原生配置类型与 Codex 不匹配".to_string());
    };
    let (_, config_advanced) = codex_advanced_config(profile)?;
    if let Some(config_advanced) = config_advanced {
        merge_json_object_into_toml(existing.as_table_mut(), config_advanced)?;
    }
    let root = existing.as_table_mut();
    root["model_provider"] = value("codemux");
    if let Some(default_model) = default_model {
        root["model"] = value(default_model);
    }
    let providers = root
        .entry("model_providers")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "Codex config.toml 的 model_providers 必须为表".to_string())?;
    let codemux = providers
        .entry("codemux")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "Codex config.toml 的 model_providers.codemux 必须为表".to_string())?;
    codemux["name"] = value("CodeMUX");
    codemux["base_url"] = value(openai_base_url.clone());
    codemux["env_key"] = value("OPENAI_API_KEY");
    Ok(existing)
}

fn codex_advanced_config(profile: &NativeProfileConfig) -> Result<CodexAdvancedConfig<'_>, String> {
    let NativeProfileConfig::Codex {
        advanced_config, ..
    } = profile
    else {
        return Err("原生配置类型与 Codex 不匹配".to_string());
    };
    let Some(advanced_config) = advanced_config else {
        return Ok((None, None));
    };
    let advanced = advanced_config
        .as_object()
        .ok_or_else(|| "Codex advanced_config 必须为对象".to_string())?;
    if advanced.keys().any(|key| key != "auth" && key != "config") {
        return Err("Codex advanced_config 仅支持 auth 和 config 字段".to_string());
    }
    let auth = match advanced.get("auth") {
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| "Codex advanced_config.auth 必须为对象".to_string())?,
        ),
        None => None,
    };
    let config = match advanced.get("config") {
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| "Codex advanced_config.config 必须为对象".to_string())?,
        ),
        None => None,
    };
    Ok((auth, config))
}

fn merge_json_object_into_toml(
    target: &mut Table,
    advanced: &Map<String, Value>,
) -> Result<(), String> {
    for (key, advanced_value) in advanced {
        if let Value::Object(advanced_table) = advanced_value {
            let target_table = target
                .entry(key)
                .or_insert(Item::Table(Table::new()))
                .as_table_mut()
                .ok_or_else(|| "Codex advanced_config.config 节点类型冲突".to_string())?;
            merge_json_object_into_toml(target_table, advanced_table)?;
            continue;
        }

        if let Some(current) = target.get(key) {
            if !toml_item_matches_json_value(current, advanced_value) {
                return Err("Codex advanced_config.config 节点类型冲突".to_string());
            }
        }
        target.insert(key, json_to_toml_item(advanced_value)?);
    }
    Ok(())
}

fn toml_item_matches_json_value(item: &Item, json_value: &Value) -> bool {
    match (item.as_value(), json_value) {
        (Some(TomlValue::String(_)), Value::String(_)) => true,
        (Some(TomlValue::Boolean(_)), Value::Bool(_)) => true,
        (Some(TomlValue::Integer(_)), Value::Number(number)) => number.as_i64().is_some(),
        (Some(TomlValue::Float(_)), Value::Number(number)) => {
            number.as_i64().is_none() && number.as_u64().is_none() && number.as_f64().is_some()
        }
        (Some(TomlValue::Array(_)), Value::Array(_)) => true,
        _ => false,
    }
}

fn json_to_toml_item(json_value: &Value) -> Result<Item, String> {
    match json_value {
        Value::Bool(bool_value) => Ok(value(*bool_value)),
        Value::Number(number) => {
            if let Some(integer_value) = number.as_i64() {
                Ok(value(integer_value))
            } else if number.as_u64().is_some() {
                Err("Codex advanced_config.config 包含不支持的数值".to_string())
            } else if let Some(float_value) = number.as_f64() {
                Ok(value(float_value))
            } else {
                Err("Codex advanced_config.config 包含不支持的数值".to_string())
            }
        }
        Value::String(string_value) => Ok(value(string_value.clone())),
        Value::Array(values) => {
            let mut array = Array::new();
            for array_value in values {
                let item = json_to_toml_item(array_value)?;
                let value = item.into_value().map_err(|_| {
                    "Codex advanced_config.config 数组不能包含对象或空值".to_string()
                })?;
                array.push(value);
            }
            Ok(Item::Value(TomlValue::Array(array)))
        }
        Value::Null | Value::Object(_) => {
            Err("Codex advanced_config.config 包含 TOML 不支持的值".to_string())
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn merge_opencode_config(existing: Value, profile: &NativeProfileConfig) -> Result<Value, String> {
    merge_opencode_config_with_model(existing, profile, None)
}

fn merge_opencode_config_with_model(
    existing: Value,
    profile: &NativeProfileConfig,
    default_model: Option<&str>,
) -> Result<Value, String> {
    let NativeProfileConfig::OpenCode {
        api_key,
        openai_base_url,
        advanced_config,
        ..
    } = profile
    else {
        return Err("原生配置类型与 OpenCode 不匹配".to_string());
    };
    let mut existing = merge_json_advanced_config(existing, advanced_config.as_ref(), "OpenCode")?;
    let root = existing
        .as_object_mut()
        .ok_or_else(|| "OpenCode opencode.json 顶层必须为对象".to_string())?;
    if let Some(default_model) = default_model {
        root.insert(
            "model".to_string(),
            Value::String(format!("codemux-openai/{default_model}")),
        );
    }
    let providers = root
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "OpenCode opencode.json 的 provider 必须为对象".to_string())?;
    let codemux = providers
        .entry("codemux-openai")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            "OpenCode opencode.json 的 provider.codemux-openai 必须为对象".to_string()
        })?;
    codemux.insert(
        "npm".to_string(),
        Value::String("@ai-sdk/openai-compatible".to_string()),
    );
    codemux.insert(
        "name".to_string(),
        Value::String("CodeMUX OpenAI-compatible".to_string()),
    );
    let options = codemux
        .entry("options")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            "OpenCode opencode.json 的 provider.codemux-openai.options 必须为对象".to_string()
        })?;
    options.insert(
        "baseURL".to_string(),
        Value::String(openai_base_url.clone()),
    );
    options.insert("apiKey".to_string(), Value::String(api_key.clone()));
    Ok(existing)
}

#[cfg(test)]
mod tests {
    use super::{
        merge_claude_settings, render_agent_profile_config, render_native_config,
        NativeConfigContents, NativeConfigPaths,
    };
    use crate::{
        config::types::AgentKind,
        provider_profiles::types::{AgentProviderProfile, NativeProfileConfig, ProfileModel},
    };
    use serde_json::Value;
    use std::path::PathBuf;

    fn test_paths() -> NativeConfigPaths {
        NativeConfigPaths::new(
            PathBuf::from("C:/test-home/.claude"),
            PathBuf::from("C:/test-home/.codex"),
            PathBuf::from("C:/test-home/.config/opencode"),
        )
    }

    fn profile(
        agent_kind: AgentKind,
        default_model: &str,
        native_config: NativeProfileConfig,
    ) -> AgentProviderProfile {
        AgentProviderProfile {
            id: format!("{}-profile", agent_kind.as_str()),
            agent_kind,
            name: "测试档案".to_string(),
            note: String::new(),
            models: vec![ProfileModel {
                id: default_model.to_string(),
                name: None,
                context_window: None,
            }],
            default_model: default_model.to_string(),
            native_config,
        }
    }

    #[test]
    fn profile_default_model_is_rendered_for_each_agent_native_config() {
        let paths = test_paths();
        let claude = profile(
            AgentKind::ClaudeCode,
            "claude-model",
            NativeProfileConfig::ClaudeCode {
                settings: serde_json::json!({ "env": {
                    "ANTHROPIC_AUTH_TOKEN": "key",
                    "ANTHROPIC_BASE_URL": "https://claude.example",
                    "ANTHROPIC_MODEL": "claude-model"
                }}),
                requires_review: false,
            },
        );
        let codex = profile(
            AgentKind::Codex,
            "codex-model",
            NativeProfileConfig::Codex {
                api_key: "key".to_string(),
                openai_base_url: "https://codex.example/v1".to_string(),
                codex_needs_proxy: None,
                advanced_config: None,
                requires_review: false,
            },
        );
        let opencode = profile(
            AgentKind::Opencode,
            "opencode-model",
            NativeProfileConfig::OpenCode {
                api_key: "key".to_string(),
                openai_base_url: "https://opencode.example/v1".to_string(),
                advanced_config: None,
                requires_review: false,
            },
        );

        let claude_rendered =
            render_agent_profile_config(&paths, &claude, &NativeConfigContents::default()).unwrap();
        let codex_rendered =
            render_agent_profile_config(&paths, &codex, &NativeConfigContents::default()).unwrap();
        let opencode_rendered =
            render_agent_profile_config(&paths, &opencode, &NativeConfigContents::default())
                .unwrap();

        let claude_settings: Value = serde_json::from_str(&claude_rendered[0].content).unwrap();
        assert_eq!(claude_settings["env"]["ANTHROPIC_MODEL"], "claude-model");
        assert!(codex_rendered[1]
            .content
            .contains("model = \"codex-model\""));
        let opencode_config: Value = serde_json::from_str(&opencode_rendered[0].content).unwrap();
        assert_eq!(opencode_config["model"], "codemux-openai/opencode-model");
    }

    #[test]
    fn 空默认模型不会渲染模型字段() {
        let paths = test_paths();
        let empty_models = Vec::new();
        let claude = AgentProviderProfile {
            id: "claude-empty".to_string(),
            agent_kind: AgentKind::ClaudeCode,
            name: "空模型 Claude 档案".to_string(),
            note: String::new(),
            models: empty_models.clone(),
            default_model: String::new(),
            native_config: NativeProfileConfig::ClaudeCode {
                settings: serde_json::json!({ "env": {
                    "ANTHROPIC_AUTH_TOKEN": "key",
                    "ANTHROPIC_BASE_URL": "https://claude.example"
                }}),
                requires_review: false,
            },
        };
        let codex = AgentProviderProfile {
            id: "codex-empty".to_string(),
            agent_kind: AgentKind::Codex,
            name: "空模型 Codex 档案".to_string(),
            note: String::new(),
            models: empty_models.clone(),
            default_model: String::new(),
            native_config: NativeProfileConfig::Codex {
                api_key: "key".to_string(),
                openai_base_url: "https://codex.example".to_string(),
                codex_needs_proxy: None,
                advanced_config: None,
                requires_review: false,
            },
        };
        let opencode = AgentProviderProfile {
            id: "opencode-empty".to_string(),
            agent_kind: AgentKind::Opencode,
            name: "空模型 OpenCode 档案".to_string(),
            note: String::new(),
            models: empty_models,
            default_model: String::new(),
            native_config: NativeProfileConfig::OpenCode {
                api_key: "key".to_string(),
                openai_base_url: "https://opencode.example".to_string(),
                advanced_config: None,
                requires_review: false,
            },
        };
        let existing = NativeConfigContents {
            claude_settings: Some(
                serde_json::json!({ "env": { "ANTHROPIC_MODEL": "existing-claude" } }).to_string(),
            ),
            codex_config: Some("model = \"existing-codex\"".to_string()),
            opencode_config: Some(serde_json::json!({ "model": "existing-opencode" }).to_string()),
            ..NativeConfigContents::default()
        };

        let claude_rendered = render_agent_profile_config(&paths, &claude, &existing).unwrap();
        let codex_rendered = render_agent_profile_config(&paths, &codex, &existing).unwrap();
        let opencode_rendered = render_agent_profile_config(&paths, &opencode, &existing).unwrap();

        let claude_settings: Value = serde_json::from_str(&claude_rendered[0].content).unwrap();
        assert_eq!(claude_settings["env"]["ANTHROPIC_MODEL"], "existing-claude");
        let codex_config = codex_rendered[1]
            .content
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert_eq!(codex_config["model"].as_str(), Some("existing-codex"));
        let opencode_config: Value = serde_json::from_str(&opencode_rendered[0].content).unwrap();
        assert_eq!(opencode_config["model"], "existing-opencode");
    }

    #[test]
    fn changing_profile_default_model_changes_rendered_codex_config() {
        let paths = test_paths();
        let mut profile = profile(
            AgentKind::Codex,
            "model-a",
            NativeProfileConfig::Codex {
                api_key: "key".to_string(),
                openai_base_url: "https://codex.example/v1".to_string(),
                codex_needs_proxy: None,
                advanced_config: None,
                requires_review: false,
            },
        );
        let before =
            render_agent_profile_config(&paths, &profile, &NativeConfigContents::default())
                .unwrap();
        profile.models[0].id = "model-b".to_string();
        profile.default_model = "model-b".to_string();

        let after = render_agent_profile_config(&paths, &profile, &NativeConfigContents::default())
            .unwrap();

        assert_ne!(before[1].content, after[1].content);
        assert!(after[1].content.contains("model = \"model-b\""));
    }

    #[test]
    fn claude_merge_writes_auth_token_and_preserves_unmanaged_settings() {
        let existing = serde_json::json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://old.example/v1",
                "ANTHROPIC_API_KEY": "old-key",
                "KEEP": "preserve-me"
            },
            "mcpServers": {
                "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }
            },
            "permissions": { "allow": ["Bash"] }
        });
        let profile = NativeProfileConfig::ClaudeCode {
            settings: serde_json::json!({ "env": {
                "ANTHROPIC_AUTH_TOKEN": "new-key",
                "ANTHROPIC_BASE_URL": "https://new.example/v1"
            }}),
            requires_review: false,
        };

        let merged = merge_claude_settings(existing, &profile).unwrap();

        assert_eq!(
            merged["env"]["ANTHROPIC_BASE_URL"],
            "https://new.example/v1"
        );
        assert_eq!(merged["env"]["ANTHROPIC_AUTH_TOKEN"], "new-key");
        assert_eq!(merged["env"]["ANTHROPIC_API_KEY"], "old-key");
        assert_eq!(merged["env"]["KEEP"], "preserve-me");
        assert_eq!(merged["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(merged["permissions"]["allow"], serde_json::json!(["Bash"]));
    }

    #[test]
    fn claude_supplier_settings_deep_merge_preserves_current_unknown_keys() {
        let merged = super::merge_claude_settings_value(
            serde_json::json!({
                "env": { "KEEP": "yes", "ANTHROPIC_MODEL": "old" },
                "permissions": { "allow": ["Bash"] }
            }),
            serde_json::json!({
                "env": { "ANTHROPIC_MODEL": "new" },
                "theme": "auto"
            }),
        )
        .unwrap();

        assert_eq!(merged["env"]["KEEP"], "yes");
        assert_eq!(merged["env"]["ANTHROPIC_MODEL"], "new");
        assert_eq!(merged["permissions"]["allow"], serde_json::json!(["Bash"]));
        assert_eq!(merged["theme"], "auto");
    }

    #[test]
    fn codex_render_outputs_auth_and_toml_and_preserves_unmanaged_fields() {
        let profile = NativeProfileConfig::Codex {
            api_key: "new-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            codex_needs_proxy: None,
            advanced_config: None,
            requires_review: false,
        };
        let existing = NativeConfigContents {
            codex_auth: Some(r#"{"OPENAI_API_KEY":"old-key","keep":"yes"}"#.to_string()),
            codex_config: Some(
                r#"
sandbox_mode = "read-only"

[mcp_servers.filesystem]
command = "npx"

[model_providers.other]
name = "Other"
"#
                .to_string(),
            ),
            ..NativeConfigContents::default()
        };

        let files = render_native_config(&test_paths(), &profile, &existing).unwrap();

        assert_eq!(files.len(), 2);
        assert_eq!(
            files[0].path,
            PathBuf::from("C:/test-home/.codex/auth.json")
        );
        assert_eq!(
            files[1].path,
            PathBuf::from("C:/test-home/.codex/config.toml")
        );
        let auth: serde_json::Value = serde_json::from_str(&files[0].content).unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "new-key");
        assert_eq!(auth["keep"], "yes");
        let config = files[1].content.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(config["sandbox_mode"].as_str(), Some("read-only"));
        assert_eq!(
            config["mcp_servers"]["filesystem"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(
            config["model_providers"]["other"]["name"].as_str(),
            Some("Other")
        );
        assert_eq!(config["model_provider"].as_str(), Some("codemux"));
        assert_eq!(
            config["model_providers"]["codemux"]["base_url"].as_str(),
            Some("https://new.example/v1")
        );
        assert_eq!(
            config["model_providers"]["codemux"]["env_key"].as_str(),
            Some("OPENAI_API_KEY")
        );
    }

    #[test]
    fn opencode_render_preserves_unknown_and_mcp_fields() {
        let profile = NativeProfileConfig::OpenCode {
            api_key: "new-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            advanced_config: None,
            requires_review: false,
        };
        let existing = NativeConfigContents {
            opencode_config: Some(
                serde_json::json!({
                    "mcp": { "filesystem": { "type": "local", "command": ["npx"] } },
                    "plugin": ["opencode-skill"],
                    "provider": { "other": { "options": { "apiKey": "other-key" } } }
                })
                .to_string(),
            ),
            ..NativeConfigContents::default()
        };

        let files = render_native_config(&test_paths(), &profile, &existing).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].path,
            PathBuf::from("C:/test-home/.config/opencode/opencode.json")
        );
        let config: serde_json::Value = serde_json::from_str(&files[0].content).unwrap();
        assert_eq!(config["mcp"]["filesystem"]["type"], "local");
        assert_eq!(config["plugin"], serde_json::json!(["opencode-skill"]));
        assert_eq!(
            config["provider"]["other"]["options"]["apiKey"],
            "other-key"
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["name"],
            "CodeMUX OpenAI-compatible"
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["options"]["baseURL"],
            "https://new.example/v1"
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["options"]["apiKey"],
            "new-key"
        );
    }

    #[test]
    fn invalid_json_or_toml_input_returns_a_redacted_error() {
        let profile = NativeProfileConfig::Codex {
            api_key: "super-secret-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            codex_needs_proxy: None,
            advanced_config: None,
            requires_review: false,
        };
        let invalid_json = NativeConfigContents {
            codex_auth: Some("{ invalid json }".to_string()),
            ..NativeConfigContents::default()
        };
        let json_error = render_native_config(&test_paths(), &profile, &invalid_json).unwrap_err();
        assert_eq!(json_error, "Codex auth.json 配置无效");
        assert!(!json_error.contains("super-secret-key"));

        let invalid_toml = NativeConfigContents {
            codex_config: Some("[broken".to_string()),
            ..NativeConfigContents::default()
        };
        let toml_error = render_native_config(&test_paths(), &profile, &invalid_toml).unwrap_err();
        assert_eq!(toml_error, "Codex config.toml 配置无效");
        assert!(!toml_error.contains("super-secret-key"));
    }

    #[test]
    fn claude_advanced_config_is_deep_merged_before_managed_env_fields() {
        let profile = NativeProfileConfig::ClaudeCode {
            settings: serde_json::json!({
                "env": {
                    "KEEP": "advanced-value",
                    "ANTHROPIC_AUTH_TOKEN": "new-key",
                    "ANTHROPIC_BASE_URL": "https://new.example/v1"
                },
                "mcpServers": { "advanced": { "command": "uvx" } },
                "customSetting": true
            }),
            requires_review: false,
        };
        let existing = serde_json::json!({
            "env": { "KEEP": "old-value" },
            "mcpServers": { "existing": { "command": "npx" } }
        });

        let merged = merge_claude_settings(existing, &profile).unwrap();

        assert_eq!(merged["env"]["KEEP"], "advanced-value");
        assert_eq!(merged["env"]["ANTHROPIC_AUTH_TOKEN"], "new-key");
        assert_eq!(merged["mcpServers"]["existing"]["command"], "npx");
        assert_eq!(merged["mcpServers"]["advanced"]["command"], "uvx");
        assert_eq!(merged["customSetting"], true);
    }

    #[test]
    fn codex_advanced_config_merges_auth_and_toml_before_managed_fields() {
        let profile = NativeProfileConfig::Codex {
            api_key: "new-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            codex_needs_proxy: None,
            advanced_config: Some(serde_json::json!({
                "auth": {
                    "refresh_token": "preserve-me",
                    "OPENAI_API_KEY": "must-not-win"
                },
                "config": {
                    "sandbox_mode": "workspace-write",
                    "mcp_servers": { "advanced": { "command": "npx" } },
                    "model_providers": { "codemux": { "request_max_retries": 3 } }
                }
            })),
            requires_review: false,
        };
        let existing = NativeConfigContents {
            codex_auth: Some(r#"{"account_id":"account-1"}"#.to_string()),
            codex_config: Some(
                r#"
[model_providers.codemux]
custom_existing = true
"#
                .to_string(),
            ),
            ..NativeConfigContents::default()
        };

        let files = render_native_config(&test_paths(), &profile, &existing).unwrap();

        let auth: serde_json::Value = serde_json::from_str(&files[0].content).unwrap();
        assert_eq!(auth["account_id"], "account-1");
        assert_eq!(auth["refresh_token"], "preserve-me");
        assert_eq!(auth["OPENAI_API_KEY"], "new-key");
        let config = files[1].content.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(config["sandbox_mode"].as_str(), Some("workspace-write"));
        assert_eq!(
            config["mcp_servers"]["advanced"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(
            config["model_providers"]["codemux"]["custom_existing"].as_bool(),
            Some(true)
        );
        assert_eq!(
            config["model_providers"]["codemux"]["request_max_retries"].as_integer(),
            Some(3)
        );
        assert_eq!(
            config["model_providers"]["codemux"]["base_url"].as_str(),
            Some("https://new.example/v1")
        );
    }

    #[test]
    fn opencode_advanced_config_preserves_managed_provider_unknown_fields() {
        let profile = NativeProfileConfig::OpenCode {
            api_key: "new-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            advanced_config: Some(serde_json::json!({
                "provider": {
                    "codemux-openai": {
                        "custom_advanced": true,
                        "options": { "timeout": 2000, "apiKey": "must-not-win" }
                    }
                },
                "mcp": { "advanced": { "type": "local" } }
            })),
            requires_review: false,
        };
        let existing = NativeConfigContents {
            opencode_config: Some(
                serde_json::json!({
                    "provider": {
                        "codemux-openai": {
                            "custom_existing": true,
                            "options": { "timeout": 1000 }
                        }
                    }
                })
                .to_string(),
            ),
            ..NativeConfigContents::default()
        };

        let files = render_native_config(&test_paths(), &profile, &existing).unwrap();
        let config: serde_json::Value = serde_json::from_str(&files[0].content).unwrap();

        assert_eq!(config["mcp"]["advanced"]["type"], "local");
        assert_eq!(
            config["provider"]["codemux-openai"]["custom_existing"],
            true
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["custom_advanced"],
            true
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["options"]["timeout"],
            2000
        );
        assert_eq!(
            config["provider"]["codemux-openai"]["options"]["apiKey"],
            "new-key"
        );
    }

    #[test]
    fn advanced_config_rejects_invalid_shapes_and_node_type_conflicts() {
        let invalid_claude = NativeProfileConfig::ClaudeCode {
            settings: serde_json::json!(["not-an-object"]),
            requires_review: false,
        };
        let error = merge_claude_settings(serde_json::json!({}), &invalid_claude).unwrap_err();
        assert_eq!(error, "Claude Code settings 必须为对象");

        let conflicting_claude = NativeProfileConfig::ClaudeCode {
            settings: serde_json::json!({ "mcpServers": [] }),
            requires_review: false,
        };
        let error = merge_claude_settings(
            serde_json::json!({ "mcpServers": { "filesystem": {} } }),
            &conflicting_claude,
        )
        .unwrap_err();
        assert_eq!(error, "Claude Code advanced_config 节点类型冲突");

        let invalid_codex = NativeProfileConfig::Codex {
            api_key: "new-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            codex_needs_proxy: None,
            advanced_config: Some(serde_json::json!({ "auth": [] })),
            requires_review: false,
        };
        let error = render_native_config(
            &test_paths(),
            &invalid_codex,
            &NativeConfigContents::default(),
        )
        .unwrap_err();
        assert_eq!(error, "Codex advanced_config.auth 必须为对象");
    }

    #[test]
    fn native_profile_debug_output_redacts_api_keys() {
        let profile = NativeProfileConfig::OpenCode {
            api_key: "super-secret-key".to_string(),
            openai_base_url: "https://new.example/v1".to_string(),
            advanced_config: Some(serde_json::json!({ "nested_key": "super-secret-key" })),
            requires_review: false,
        };

        let debug = format!("{profile:?}");

        assert!(!debug.contains("super-secret-key"));
        assert!(debug.contains("[已脱敏]"));
    }

    #[test]
    fn codex_toml_advanced_merge_rejects_scalar_and_inline_table_type_conflicts() {
        let mut scalar_document = "sandbox_mode = \"workspace-write\""
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let scalar_advanced = serde_json::json!({ "sandbox_mode": true });

        let error = super::merge_json_object_into_toml(
            scalar_document.as_table_mut(),
            scalar_advanced.as_object().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error, "Codex advanced_config.config 节点类型冲突");
        assert_eq!(
            scalar_document["sandbox_mode"].as_str(),
            Some("workspace-write")
        );

        let mut inline_table_document = "limits = { retries = 3 }"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let inline_table_advanced = serde_json::json!({ "limits": "must-not-replace" });

        let error = super::merge_json_object_into_toml(
            inline_table_document.as_table_mut(),
            inline_table_advanced.as_object().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error, "Codex advanced_config.config 节点类型冲突");
        assert_eq!(
            inline_table_document["limits"]["retries"].as_integer(),
            Some(3)
        );
    }

    #[test]
    fn rendered_native_config_debug_output_redacts_content() {
        let rendered = super::RenderedNativeConfig {
            path: PathBuf::from("C:/test-home/.codex/auth.json"),
            content: "{\"OPENAI_API_KEY\":\"super-secret-key\"}".to_string(),
        };

        let debug = format!("{rendered:?}");

        assert!(!debug.contains("super-secret-key"));
        assert!(debug.contains("[已脱敏]"));
    }
}
