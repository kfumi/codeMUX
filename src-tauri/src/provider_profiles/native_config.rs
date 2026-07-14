use crate::provider_profiles::types::NativeProfileConfig;
use serde_json::{Map, Value};
use std::path::PathBuf;
use toml_edit::{value, DocumentMut, Item, Table};

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeConfigContents {
    pub claude_settings: Option<String>,
    pub codex_auth: Option<String>,
    pub codex_config: Option<String>,
    pub opencode_config: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedNativeConfig {
    pub path: PathBuf,
    pub content: String,
}

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

pub fn merge_claude_settings(
    mut existing: Value,
    profile: &NativeProfileConfig,
) -> Result<Value, String> {
    let NativeProfileConfig::ClaudeCode {
        api_key,
        anthropic_base_url,
        ..
    } = profile
    else {
        return Err("原生配置类型与 Claude Code 不匹配".to_string());
    };

    let settings = existing
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 顶层必须为对象".to_string())?;
    let env = settings
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 的 env 必须为对象".to_string())?;

    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        Value::String(anthropic_base_url.clone()),
    );
    env.insert(
        "ANTHROPIC_API_KEY".to_string(),
        Value::String(api_key.clone()),
    );
    Ok(existing)
}

fn merge_codex_auth(mut existing: Value, profile: &NativeProfileConfig) -> Result<Value, String> {
    let NativeProfileConfig::Codex { api_key, .. } = profile else {
        return Err("原生配置类型与 Codex 不匹配".to_string());
    };
    let auth = existing
        .as_object_mut()
        .ok_or_else(|| "Codex auth.json 顶层必须为对象".to_string())?;
    auth.insert("OPENAI_API_KEY".to_string(), Value::String(api_key.clone()));
    Ok(existing)
}

fn merge_codex_config(
    mut existing: DocumentMut,
    profile: &NativeProfileConfig,
) -> Result<DocumentMut, String> {
    let NativeProfileConfig::Codex {
        openai_base_url, ..
    } = profile
    else {
        return Err("原生配置类型与 Codex 不匹配".to_string());
    };
    let root = existing.as_table_mut();
    root["model_provider"] = value("codemux");
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

fn merge_opencode_config(
    mut existing: Value,
    profile: &NativeProfileConfig,
) -> Result<Value, String> {
    let NativeProfileConfig::OpenCode {
        api_key,
        openai_base_url,
        ..
    } = profile
    else {
        return Err("原生配置类型与 OpenCode 不匹配".to_string());
    };
    let root = existing
        .as_object_mut()
        .ok_or_else(|| "OpenCode opencode.json 顶层必须为对象".to_string())?;
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
        merge_claude_settings, render_native_config, NativeConfigContents, NativeConfigPaths,
    };
    use crate::provider_profiles::types::NativeProfileConfig;
    use std::path::PathBuf;

    fn test_paths() -> NativeConfigPaths {
        NativeConfigPaths::new(
            PathBuf::from("C:/test-home/.claude"),
            PathBuf::from("C:/test-home/.codex"),
            PathBuf::from("C:/test-home/.config/opencode"),
        )
    }

    #[test]
    fn claude_merge_replaces_anthropic_credentials_and_preserves_other_settings() {
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
            api_key: "new-key".to_string(),
            anthropic_base_url: "https://new.example/v1".to_string(),
            context_1m: None,
            advanced_config: None,
            requires_review: false,
        };

        let merged = merge_claude_settings(existing, &profile).unwrap();

        assert_eq!(
            merged["env"]["ANTHROPIC_BASE_URL"],
            "https://new.example/v1"
        );
        assert_eq!(merged["env"]["ANTHROPIC_API_KEY"], "new-key");
        assert_eq!(merged["env"]["KEEP"], "preserve-me");
        assert_eq!(merged["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(merged["permissions"]["allow"], serde_json::json!(["Bash"]));
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
}
