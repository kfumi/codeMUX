use super::claude_code::ClaudeCodeRuntime;
use super::codex::CodexRuntime;
use super::opencode::OpenCodeRuntime;
use super::types::AgentRuntime;

/// Resolve a runtime instance for the given agent_kind string.
/// Falls back to ClaudeCodeRuntime for unknown kinds.
pub fn runtime_for_agent_kind(agent_kind: &str) -> Box<dyn AgentRuntime> {
    match agent_kind {
        "codex" => Box::new(CodexRuntime),
        "opencode" => Box::new(OpenCodeRuntime),
        _ => Box::new(ClaudeCodeRuntime),
    }
}

/// Look up the session's agent_kind from the database and return a runtime instance.
pub fn session_runtime(
    db: &rusqlite::Connection,
    session_id: &str,
) -> Result<Box<dyn AgentRuntime>, String> {
    let agent_kind: String = db
        .query_row(
            "SELECT agent_kind FROM sessions WHERE id = ?1",
            rusqlite::params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Session not found {}: {}", session_id, e))?;

    Ok(runtime_for_agent_kind(&agent_kind))
}

/// Look up the session's agent_kind and return the kind name string.
/// Used by agent::commands to pass agent_kind to the sidecar.
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
    fn resolves_claude_and_codex_runtime_variants() {
        let claude = runtime_for_agent_kind("claude_code");
        assert_eq!(claude.kind_name(), "claude_code");

        let codex = runtime_for_agent_kind("codex");
        assert_eq!(codex.kind_name(), "codex");

        let opencode = runtime_for_agent_kind("opencode");
        assert_eq!(opencode.kind_name(), "opencode");
    }

    #[test]
    fn falls_back_to_claude_for_unknown() {
        let runtime = runtime_for_agent_kind("gemini_cli");
        assert_eq!(runtime.kind_name(), "claude_code");

        let runtime = runtime_for_agent_kind("");
        assert_eq!(runtime.kind_name(), "claude_code");
    }

    #[test]
    fn reports_missing_session_instead_of_returning_a_claude_runtime() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let error = session_runtime_kind_name(&db, "missing-session").unwrap_err();
        assert!(error.contains("Session not found missing-session"));
    }
}
