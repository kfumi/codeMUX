use std::path::PathBuf;

use crate::mcp::adapter::McpAdapter;
use crate::mcp::types::{McpServer, McpTransport};

fn claude_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}

/// Convert internal MCP server records into Claude SDK `mcpServers` config.
pub fn to_sdk_config(servers: &[McpServer]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = servers
        .iter()
        .map(|server| {
            let mut config = server.transport.to_config_json();
            if let serde_json::Value::Object(ref mut obj) = config {
                if server.always_load {
                    obj.insert("alwaysLoad".to_string(), serde_json::Value::Bool(true));
                }
                if matches!(&server.transport, McpTransport::Stdio { .. }) {
                    obj.remove("type");
                }
            }
            (server.name.clone(), config)
        })
        .collect();

    serde_json::Value::Object(map)
}

pub struct ClaudeAdapter;

impl McpAdapter for ClaudeAdapter {
    fn to_config(&self, servers: &[McpServer]) -> Result<serde_json::Value, String> {
        Ok(to_sdk_config(servers))
    }

    fn import_from_config(&self, config: &serde_json::Value) -> Result<Vec<McpServer>, String> {
        let mcp_servers = config
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let mut result = Vec::new();
        for (name, server_config) in mcp_servers {
            let mut server_config = server_config.clone();
            let always_load = server_config
                .get("alwaysLoad")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if let serde_json::Value::Object(ref mut obj) = server_config {
                obj.remove("alwaysLoad");
            }

            let transport: McpTransport = serde_json::from_value(server_config)
                .map_err(|e| format!("Failed to parse MCP server '{}': {}", name, e))?;

            let now = chrono::Utc::now().to_rfc3339();
            result.push(McpServer {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                description: String::new(),
                subtitle: String::new(),
                always_load,
                transport,
                enabled: true,
                created_at: now.clone(),
                updated_at: now,
            });
        }
        Ok(result)
    }

    fn sync_to_config_file(&self, servers: &[McpServer]) -> Result<(), String> {
        let path = claude_config_path();

        let mut config: serde_json::Value = if path.exists() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read ~/.claude.json: {}", e))?;
            serde_json::from_str(&content)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };

        let mcp_config = self.to_config(servers)?;
        if let serde_json::Value::Object(ref mut obj) = config {
            if mcp_config.as_object().map_or(true, |m| m.is_empty()) {
                obj.remove("mcpServers");
            } else {
                obj.insert("mcpServers".to_string(), mcp_config);
            }
        }

        let content = serde_json::to_string_pretty(&config)
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
}

#[cfg(test)]
mod tests {
    use super::to_sdk_config;
    use crate::mcp::types::{McpServer, McpTransport};

    #[test]
    fn sdk_config_only_sets_always_load_when_enabled() {
        let servers = vec![
            McpServer {
                id: "1".into(),
                name: "context7".into(),
                description: String::new(),
                subtitle: String::new(),
                always_load: true,
                transport: McpTransport::Http {
                    url: "https://example.com/mcp".into(),
                    headers: Default::default(),
                },
                enabled: true,
                created_at: String::new(),
                updated_at: String::new(),
            },
            McpServer {
                id: "2".into(),
                name: "filesystem".into(),
                description: String::new(),
                subtitle: String::new(),
                always_load: false,
                transport: McpTransport::Stdio {
                    command: "npx".into(),
                    args: vec!["demo".into()],
                    env: Default::default(),
                },
                enabled: true,
                created_at: String::new(),
                updated_at: String::new(),
            },
        ];

        let config = to_sdk_config(&servers);
        let context7 = &config["context7"];
        let filesystem = &config["filesystem"];

        assert_eq!(context7["alwaysLoad"], serde_json::Value::Bool(true));
        assert!(filesystem.get("alwaysLoad").is_none());
        assert!(filesystem.get("type").is_none());
    }
}
