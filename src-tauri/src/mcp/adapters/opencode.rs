use crate::mcp::adapter::{McpAdapter, McpAdapterResult};

pub struct OpenCodeAdapter;

fn opencode_config_path() -> std::path::PathBuf {
    // opencode.json lives in the project root (current working directory)
    std::env::current_dir()
        .unwrap_or_default()
        .join("opencode.json")
}

/// Convert unified format to OpenCode format.
pub fn convert_to_opencode_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let server_type = spec
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("stdio");
    match server_type {
        "stdio" => Ok(serde_json::json!({
            "type": "local",
            "command": std::iter::once(spec["command"].as_str().unwrap_or_default().to_string())
                .chain(
                    spec.get("args")
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|value| value.as_str().map(str::to_string))
                )
                .collect::<Vec<_>>(),
            "environment": spec.get("env").cloned().unwrap_or_else(|| serde_json::json!({}))
        })),
        "http" | "sse" => Ok(serde_json::json!({
            "type": "remote",
            "url": spec["url"].clone(),
            "headers": spec.get("headers").cloned().unwrap_or_else(|| serde_json::json!({}))
        })),
        other => Err(format!("unsupported opencode type: {other}")),
    }
}

fn read_opencode_json() -> Result<serde_json::Value, String> {
    let path = opencode_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read opencode.json: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse opencode.json: {}", e))
}

fn write_opencode_json(config: &serde_json::Value) -> Result<(), String> {
    let path = opencode_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write opencode.json: {}", e))?;
    Ok(())
}

impl McpAdapter for OpenCodeAdapter {
    fn should_sync(&self) -> bool {
        opencode_config_path().exists()
    }

    fn sync_single_server(
        &self,
        name: &str,
        server_spec: &serde_json::Value,
    ) -> McpAdapterResult<()> {
        let mut config = read_opencode_json()?;
        let oc_spec = convert_to_opencode_server(server_spec)?;
        config["mcp"][name] = oc_spec;
        write_opencode_json(&config)
    }

    fn remove_server(&self, name: &str) -> McpAdapterResult<()> {
        let mut config = read_opencode_json()?;
        if let Some(mcp) = config.get_mut("mcp").and_then(|v| v.as_object_mut()) {
            mcp.remove(name);
        }
        write_opencode_json(&config)
    }

    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>> {
        // OpenCode import not implemented — project-specific config
        Ok(Vec::new())
    }
}
