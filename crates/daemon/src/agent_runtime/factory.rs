use super::types::AgentRuntimeKind;

/// 解析 kind 字符串对应的运行时种类。
///
/// 唯一的用途是「这个 kind 最终由哪个运行时承载」这类判断。daemon 不持有运行时
/// 对象：真正的运行时在 sidecar 内，daemon 只发命令信封。
pub fn runtime_kind_for(agent_kind: &str) -> AgentRuntimeKind {
    AgentRuntimeKind::from_agent_kind(agent_kind)
}

/// 查会话的 kind 并返回其运行时种类名。
pub fn session_runtime_kind_name(
    db: &rusqlite::Connection,
    session_id: &str,
) -> Result<String, String> {
    let agent_kind: String = db
        .query_row(
            "SELECT agent_kind FROM sessions WHERE id = ?1",
            rusqlite::params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Session not found {}: {}", session_id, e))?;

    Ok(agent_kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_each_runtime_kind() {
        assert_eq!(runtime_kind_for("claude_code").as_str(), "claude_code");
        assert_eq!(runtime_kind_for("codex").as_str(), "codex");
        assert_eq!(runtime_kind_for("opencode").as_str(), "opencode");
        assert_eq!(runtime_kind_for("pi").as_str(), "pi");
    }

    #[test]
    fn falls_back_to_claude_for_unknown_kinds() {
        // `gemini_cli` 与未来未知值都走 claude 回退 —— 这是既有行为，
        // `mcp_tooling_applies_to` 依赖它给这些会话注入工具面。
        assert_eq!(runtime_kind_for("gemini_cli").as_str(), "claude_code");
        assert_eq!(runtime_kind_for("").as_str(), "claude_code");
    }

    #[test]
    fn reports_missing_session_instead_of_returning_a_claude_runtime() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let error = session_runtime_kind_name(&db, "missing-session").unwrap_err();
        assert!(error.contains("Session not found missing-session"));
    }
}
