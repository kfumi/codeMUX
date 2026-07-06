use crate::mcp::adapter::{McpAdapter, McpAdapterResult};

pub struct GeminiAdapter;

fn gemini_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".gemini")
        .join("settings.json")
}

/// Convert a Gemini-format server to unified format.
pub fn convert_from_gemini_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut obj = spec
        .as_object()
        .cloned()
        .ok_or("gemini server must be an object")?;
    if let Some(url) = obj.remove("httpUrl") {
        obj.insert("type".into(), serde_json::Value::String("http".into()));
        obj.insert("url".into(), url);
    } else if obj.contains_key("url") {
        obj.insert("type".into(), serde_json::Value::String("sse".into()));
    } else {
        obj.insert("type".into(), serde_json::Value::String("stdio".into()));
    }
    Ok(serde_json::Value::Object(obj))
}

/// Convert unified format to Gemini format.
pub fn convert_to_gemini_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut obj = spec
        .as_object()
        .cloned()
        .ok_or("server spec must be an object")?;
    if obj.get("type").and_then(|value| value.as_str()) == Some("http") {
        if let Some(url) = obj.remove("url") {
            obj.insert("httpUrl".into(), url);
        }
    }
    obj.remove("type");
    Ok(serde_json::Value::Object(obj))
}

fn read_gemini_json() -> Result<serde_json::Value, String> {
    let path = gemini_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read gemini settings: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse gemini settings: {}", e))
}

fn write_gemini_json(config: &serde_json::Value) -> Result<(), String> {
    let path = gemini_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create gemini config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize gemini config: {}", e))?;
    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write gemini settings: {}", e))?;
    Ok(())
}

impl McpAdapter for GeminiAdapter {
    fn should_sync(&self) -> bool {
        gemini_config_path().parent().is_some_and(|p| p.exists())
    }

    fn sync_single_server(
        &self,
        name: &str,
        server_spec: &serde_json::Value,
    ) -> McpAdapterResult<()> {
        let mut config = read_gemini_json()?;
        let gemini_spec = convert_to_gemini_server(server_spec)?;
        config["mcpServers"][name] = gemini_spec;
        write_gemini_json(&config)
    }

    fn remove_server(&self, name: &str) -> McpAdapterResult<()> {
        let mut config = read_gemini_json()?;
        if let Some(mcp_servers) = config.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
            mcp_servers.remove(name);
        }
        write_gemini_json(&config)
    }

    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>> {
        let config = read_gemini_json()?;
        let mcp_servers = config
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let mut result = Vec::new();
        for (name, gemini_spec) in mcp_servers {
            let unified = convert_from_gemini_server(&gemini_spec)?;
            result.push((name, unified));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_adapter_maps_http_url_both_directions() {
        let imported = convert_from_gemini_server(&serde_json::json!({
            "httpUrl": "https://mcp.example.com",
            "headers": { "X-Test": "1" }
        }))
        .unwrap();

        assert_eq!(imported["type"], "http");
        assert_eq!(imported["url"], "https://mcp.example.com");

        let exported = convert_to_gemini_server(&imported).unwrap();
        assert_eq!(exported["httpUrl"], "https://mcp.example.com");
        assert!(exported.get("type").is_none());
    }

    #[test]
    fn gemini_adapter_stdio_without_url() {
        let imported = convert_from_gemini_server(&serde_json::json!({
            "command": "npx",
            "args": ["-y", "some-server"]
        }))
        .unwrap();

        assert_eq!(imported["type"], "stdio");
        assert_eq!(imported["command"], "npx");
    }
}
