use std::path::PathBuf;
use crate::mcp::types::{McpServer, McpTransport};
use crate::mcp::adapter::McpAdapter;

fn claude_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}

/// 将 McpServer 列表转为 Claude SDK mcpServers 格式
pub fn to_sdk_config(servers: &[McpServer]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = servers
        .iter()
        .map(|s| {
            let mut config = s.transport.to_config_json();
            // Claude SDK: stdio 不需要显式 type 字段（SDK 默认就是 stdio）
            if let serde_json::Value::Object(ref mut obj) = config {
                if matches!(&s.transport, McpTransport::Stdio { .. }) {
                    obj.remove("type");
                }
            }
            (s.name.clone(), config)
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
        let mcp_servers = config.get("mcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let mut result = Vec::new();
        for (name, server_config) in mcp_servers {
            let transport: McpTransport = serde_json::from_value(server_config.clone())
                .map_err(|e| format!("Failed to parse MCP server '{}': {}", name, e))?;

            let now = chrono::Utc::now().to_rfc3339();
            result.push(McpServer {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                description: String::new(),
                subtitle: String::new(),
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

        // 读取现有配置（如果存在）
        let mut config: serde_json::Value = if path.exists() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read ~/.claude.json: {}", e))?;
            serde_json::from_str(&content)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };

        // 更新 mcpServers 字段
        let mcp_config = self.to_config(servers)?;
        if let serde_json::Value::Object(ref mut obj) = config {
            if mcp_config.as_object().map_or(true, |m| m.is_empty()) {
                obj.remove("mcpServers");
            } else {
                obj.insert("mcpServers".to_string(), mcp_config);
            }
        }

        // 原子写入：先写临时文件，再重命名（防止写入中途崩溃导致文件损坏）
        let content = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &content)
            .map_err(|e| format!("Failed to write temp file: {}", e))?;
        // Windows: rename 不能覆盖已存在的文件，需要先删除
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove old ~/.claude.json: {}", e))?;
        }
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| format!("Failed to rename temp file to ~/.claude.json: {}", e))?;

        Ok(())
    }
}
