use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Agent kinds supported by the runtime.
///
/// 这是 kind 字符串与规范名之间的唯一映射，`as_str()` 与 `from_agent_kind()`
/// 互为逆运算。daemon 侧判断「这个 kind 最终由哪个运行时承载」时用它，
/// 不再为了一次字符串比较而构造运行时对象。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeKind {
    ClaudeCode,
    Codex,
    OpenCode,
    Pi,
}

impl AgentRuntimeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }

    pub fn from_agent_kind(agent_kind: &str) -> Self {
        match agent_kind {
            "codex" => Self::Codex,
            "opencode" => Self::OpenCode,
            "pi" => Self::Pi,
            _ => Self::ClaudeCode,
        }
    }
}

/// 构造 `send_input` 命令。
pub fn send_input_command(
    session_id: &str,
    prompt: String,
    display_content: Option<&str>,
) -> Value {
    let mut command = json!({
        "type": "send_input",
        "sessionId": session_id,
        "prompt": prompt,
    });
    if let Some(display_content) = display_content {
        command["displayContent"] = Value::String(display_content.to_string());
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_kind_variant() {
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("claude_code"),
            AgentRuntimeKind::ClaudeCode
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("codex"),
            AgentRuntimeKind::Codex
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("opencode"),
            AgentRuntimeKind::OpenCode
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("pi"),
            AgentRuntimeKind::Pi
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("unknown"),
            AgentRuntimeKind::ClaudeCode
        );
    }

    #[test]
    fn kind_name_round_trips() {
        for kind in [
            AgentRuntimeKind::ClaudeCode,
            AgentRuntimeKind::Codex,
            AgentRuntimeKind::OpenCode,
            AgentRuntimeKind::Pi,
        ] {
            assert_eq!(
                AgentRuntimeKind::from_agent_kind(kind.as_str()),
                kind,
                "as_str/from_agent_kind 必须互逆"
            );
        }
    }
}
