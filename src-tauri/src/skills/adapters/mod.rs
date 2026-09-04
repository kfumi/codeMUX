pub mod claude;
pub mod codex;
pub mod gemini;
pub mod opencode;
pub mod pi;

use super::adapter::SkillAdapter;

pub fn get_adapter(app: &str) -> Option<&'static dyn SkillAdapter> {
    match app {
        "claude" => Some(&claude::ClaudeSkillAdapter),
        "codex" => Some(&codex::CodexSkillAdapter),
        "gemini" => Some(&gemini::GeminiSkillAdapter),
        "opencode" => Some(&opencode::OpenCodeSkillAdapter),
        "pi" => Some(&pi::PiSkillAdapter),
        _ => None,
    }
}

pub fn all_apps() -> [&'static str; 5] {
    ["claude", "codex", "gemini", "opencode", "pi"]
}
