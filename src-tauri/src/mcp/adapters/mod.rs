pub mod claude;
pub mod codex;
pub mod gemini;
pub mod opencode;

use super::adapter::McpAdapter;

pub fn get_adapter(app: &str) -> Option<&'static dyn McpAdapter> {
    match app {
        "claude" => Some(&claude::ClaudeAdapter),
        "codex" => Some(&codex::CodexAdapter),
        "gemini" => Some(&gemini::GeminiAdapter),
        "opencode" => Some(&opencode::OpenCodeAdapter),
        _ => None,
    }
}

pub fn all_apps() -> [&'static str; 4] {
    ["claude", "codex", "gemini", "opencode"]
}
