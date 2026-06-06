use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub installed_at: String,
    pub enabled: bool,
    pub is_builtin: bool,
    /// Absolute path to the skill directory on disk (for plugin/disk skills).
    /// Used to read SKILL.md content from the actual location.
    pub disk_path: Option<String>,
}
