use crate::mcp::adapter::{McpAdapter, McpAdapterResult};

pub struct CodexAdapter;

fn codex_config_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".codex")
        .join("config.toml")
}

/// Convert a unified JSON server spec into a TOML table for Codex config.
pub fn json_server_to_toml_table(spec: &serde_json::Value) -> Result<toml_edit::Table, String> {
    let mut table = toml_edit::Table::new();
    let server_type = spec
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("stdio");
    table["type"] = toml_edit::value(server_type);

    match server_type {
        "stdio" => {
            table["command"] = toml_edit::value(spec["command"].as_str().unwrap_or_default());
            if let Some(args) = spec.get("args").and_then(|value| value.as_array()) {
                let mut arr = toml_edit::Array::new();
                for arg in args {
                    if let Some(s) = arg.as_str() {
                        arr.push(s);
                    }
                }
                table["args"] = toml_edit::value(arr);
            }
        }
        "http" | "sse" => {
            table["url"] = toml_edit::value(spec["url"].as_str().unwrap_or_default());
            if let Some(headers) = spec.get("headers").and_then(|value| value.as_object()) {
                let mut headers_table = toml_edit::Table::new();
                for (key, value) in headers {
                    headers_table[key] = toml_edit::value(value.as_str().unwrap_or_default());
                }
                table["http_headers"] = toml_edit::Item::Table(headers_table);
            }
        }
        other => return Err(format!("unsupported codex type: {other}")),
    }

    Ok(table)
}

fn read_codex_config() -> Result<toml_edit::DocumentMut, String> {
    let path = codex_config_path();
    if !path.exists() {
        return Ok(toml_edit::DocumentMut::new());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config.toml: {}", e))?;
    content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse config.toml: {}", e))
}

fn write_codex_config(doc: &toml_edit::DocumentMut) -> Result<(), String> {
    let path = codex_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create codex config dir: {}", e))?;
    }
    std::fs::write(&path, doc.to_string())
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;
    Ok(())
}

impl McpAdapter for CodexAdapter {
    fn should_sync(&self) -> bool {
        codex_config_path().parent().is_some_and(|p| p.exists())
    }

    fn sync_single_server(
        &self,
        name: &str,
        server_spec: &serde_json::Value,
    ) -> McpAdapterResult<()> {
        let mut doc = read_codex_config()?;
        let table = json_server_to_toml_table(server_spec)?;
        doc["mcp_servers"][name] = toml_edit::Item::Table(table);
        write_codex_config(&doc)
    }

    fn remove_server(&self, name: &str) -> McpAdapterResult<()> {
        let mut doc = read_codex_config()?;
        if let Some(mcp_servers) = doc
            .get_mut("mcp_servers")
            .and_then(|v| v.as_table_like_mut())
        {
            mcp_servers.remove(name);
        }
        write_codex_config(&doc)
    }

    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>> {
        let doc = read_codex_config()?;
        log::info!(target: "mcp_import", "codex: config root keys: {:?}", doc.as_table().iter().map(|(k,_)| k).collect::<Vec<_>>());
        let Some(mcp_servers) = doc.get("mcp_servers").and_then(|v| v.as_table_like()) else {
            log::info!(target: "mcp_import", "codex: no mcp_servers table found");
            return Ok(Vec::new());
        };
        log::info!(target: "mcp_import", "codex: found {} mcp_servers entries", mcp_servers.len());

        let mut result = Vec::new();
        for (name, item) in mcp_servers.iter() {
            let Some(table) = item.as_table_like() else {
                continue;
            };
            let server_type = table
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("stdio");
            let mut spec = serde_json::Map::new();
            spec.insert(
                "type".into(),
                serde_json::Value::String(server_type.to_string()),
            );

            match server_type {
                "stdio" => {
                    if let Some(cmd) = table.get("command").and_then(|v| v.as_str()) {
                        spec.insert("command".into(), serde_json::Value::String(cmd.to_string()));
                    }
                    if let Some(args) = table.get("args").and_then(|v| v.as_array()) {
                        let arr: Vec<serde_json::Value> = args
                            .iter()
                            .filter_map(|v| {
                                v.as_str().map(|s| serde_json::Value::String(s.to_string()))
                            })
                            .collect();
                        spec.insert("args".into(), serde_json::Value::Array(arr));
                    }
                }
                "http" | "sse" => {
                    if let Some(url) = table.get("url").and_then(|v| v.as_str()) {
                        spec.insert("url".into(), serde_json::Value::String(url.to_string()));
                    }
                    if let Some(headers) = table.get("http_headers").and_then(|v| v.as_table_like())
                    {
                        let mut h = serde_json::Map::new();
                        for (k, v) in headers.iter() {
                            if let Some(s) = v.as_str() {
                                h.insert(k.into(), serde_json::Value::String(s.to_string()));
                            }
                        }
                        spec.insert("headers".into(), serde_json::Value::Object(h));
                    }
                }
                _ => continue,
            }

            result.push((name.to_string(), serde_json::Value::Object(spec)));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_adapter_maps_headers_to_http_headers() {
        let spec = serde_json::json!({
            "type": "http",
            "url": "https://mcp.example.com",
            "headers": { "Authorization": "Bearer token" }
        });

        let table = json_server_to_toml_table(&spec).unwrap();
        assert_eq!(table["type"].as_str(), Some("http"));
        assert_eq!(table["url"].as_str(), Some("https://mcp.example.com"));
        assert_eq!(
            table["http_headers"]["Authorization"].as_str(),
            Some("Bearer token")
        );
    }

    #[test]
    fn codex_adapter_stdio_with_args() {
        let spec = serde_json::json!({
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-fetch"]
        });

        let table = json_server_to_toml_table(&spec).unwrap();
        assert_eq!(table["type"].as_str(), Some("stdio"));
        assert_eq!(table["command"].as_str(), Some("npx"));
        let args = table["args"].as_array().unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args.get(0).and_then(|v| v.as_str()), Some("-y"));
    }

    #[test]
    fn codex_import_handles_nested_env_subtable() {
        let toml_str = r#"
[mcp_servers]

[mcp_servers.server_a]
type = "stdio"
command = "npx"
args = ["-y", "some-server"]

[mcp_servers.server_a.env]
TOKEN = "abc"

[mcp_servers.server_b]
type = "stdio"
command = "cmd"
args = ["/c", "npx", "-y", "other-server"]
"#;
        let doc: toml_edit::DocumentMut = toml_str.parse().unwrap();
        let mcp_servers = doc.get("mcp_servers").unwrap().as_table_like().unwrap();

        let mut names: Vec<&str> = Vec::new();
        for (name, item) in mcp_servers.iter() {
            if item.as_table_like().is_some() {
                let has_cmd = item
                    .as_table_like()
                    .and_then(|t| t.get("command"))
                    .and_then(|v| v.as_str())
                    .is_some();
                names.push(name);
                println!("  entry: {} has_command={}", name, has_cmd);
            }
        }
        // server_a.env should NOT appear as a direct child
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"server_a"));
        assert!(names.contains(&"server_b"));
        assert!(!names.contains(&"server_a.env"));
    }
}
