use std::path::PathBuf;

use crate::mcp::adapter::{McpAdapter, McpAdapterResult};

fn claude_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}

fn read_claude_json() -> Result<serde_json::Value, String> {
    let path = claude_config_path();
    if !path.exists() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read ~/.claude.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse ~/.claude.json: {}", e))
}

fn write_claude_json(config: &serde_json::Value) -> Result<(), String> {
    let path = claude_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove old ~/.claude.json: {}", e))?;
    }
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename temp file to ~/.claude.json: {}", e))?;
    Ok(())
}

pub struct ClaudeAdapter;

impl McpAdapter for ClaudeAdapter {
    fn should_sync(&self) -> bool {
        claude_config_path().exists()
            || PathBuf::from(
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_default(),
            )
            .join(".claude")
            .exists()
    }

    fn sync_single_server(&self, name: &str, server_spec: &serde_json::Value) -> McpAdapterResult<()> {
        let mut config = read_claude_json()?;
        let mcp_servers = config
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or("mcpServers not found or not an object")?;

        // Add type: "stdio" back if missing (Claude SDK expects it)
        let mut spec = server_spec.clone();
        if let serde_json::Value::Object(ref mut obj) = spec {
            if !obj.contains_key("type") {
                // Infer type: if url exists -> http, else stdio
                let t = if obj.contains_key("url") { "http" } else { "stdio" };
                obj.insert("type".into(), serde_json::Value::String(t.into()));
            }
        }

        mcp_servers.insert(name.to_string(), spec);
        write_claude_json(&config)
    }

    fn remove_server(&self, name: &str) -> McpAdapterResult<()> {
        let mut config = read_claude_json()?;
        if let Some(mcp_servers) = config.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
            mcp_servers.remove(name);
        }
        write_claude_json(&config)
    }

    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>> {
        let config = read_claude_json()?;
        log::info!(target: "mcp_import", "claude: config keys: {:?}", config.as_object().map(|o| o.keys().collect::<Vec<_>>()));
        let mcp_servers = config
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        log::info!(target: "mcp_import", "claude: found {} mcpServers entries", mcp_servers.len());

        let mut result = Vec::new();
        for (name, server_config) in mcp_servers {
            let mut spec = server_config.clone();
            // Strip alwaysLoad — it's a UI field, not part of server spec
            if let serde_json::Value::Object(ref mut obj) = spec {
                obj.remove("alwaysLoad");
                // For stdio, Claude SDK omits type — add it back for unified format
                if !obj.contains_key("type") {
                    let t = if obj.contains_key("url") { "http" } else { "stdio" };
                    obj.insert("type".into(), serde_json::Value::String(t.into()));
                }
            }
            result.push((name, spec));
        }
        Ok(result)
    }
}
