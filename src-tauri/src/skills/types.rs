use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub opencode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub installed_at: String,
    pub apps: SkillApps,
    /// Absolute path to the skill directory on disk (for plugin/disk skills).
    /// Used to read SKILL.md content from the actual location.
    pub disk_path: Option<String>,
    pub directory: String,
}

/// A skill discovered in an agent's skills directory that is not yet managed by codeMUX.
/// Used by the import preview dialog to let the user choose which skills to import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportableSkill {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// Source agent app identifier: "claude" | "codex" | "gemini" | "opencode"
    pub source_app: String,
    /// Absolute path to the skill directory on disk
    pub disk_path: String,
}
