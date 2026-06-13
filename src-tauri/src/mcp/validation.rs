pub fn validate_server_spec(spec: &serde_json::Value) -> Result<(), String> {
    let server_type = spec.get("type").and_then(|value| value.as_str()).unwrap_or("stdio");
    match server_type {
        "stdio" => {
            if spec.get("command").and_then(|value| value.as_str()).is_none_or(str::is_empty) {
                return Err("stdio 类型必须提供 command".into());
            }
        }
        "http" | "sse" => {
            if spec.get("url").and_then(|value| value.as_str()).is_none_or(str::is_empty) {
                return Err(format!("{server_type} 类型必须提供 url"));
            }
        }
        other => return Err(format!("不支持的 type: {other}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_server_spec_requires_command_or_url() {
        assert!(validate_server_spec(&serde_json::json!({"type":"stdio"})).is_err());
        assert!(validate_server_spec(&serde_json::json!({"type":"http"})).is_err());
        assert!(validate_server_spec(&serde_json::json!({"type":"sse","url":"https://mcp.example.com"})).is_ok());
        assert!(validate_server_spec(&serde_json::json!({"type":"stdio","command":"npx"})).is_ok());
    }
}
