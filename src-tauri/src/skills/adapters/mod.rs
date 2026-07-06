pub mod claude;
pub mod codex;
pub mod gemini;
pub mod opencode;

use super::adapter::SkillAdapter;

pub fn get_adapter(app: &str) -> Option<&'static dyn SkillAdapter> {
    match app {
        "claude" => Some(&claude::ClaudeSkillAdapter),
        "codex" => Some(&codex::CodexSkillAdapter),
        "gemini" => Some(&gemini::GeminiSkillAdapter),
        "opencode" => Some(&opencode::OpenCodeSkillAdapter),
        _ => None,
    }
}

pub fn all_apps() -> [&'static str; 4] {
    ["claude", "codex", "gemini", "opencode"]
}
