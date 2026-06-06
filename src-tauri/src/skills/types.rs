use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub source_repo: Option<String>,
    pub source_path: Option<String>,
    pub version: Option<String>,
    pub installed_at: String,
    pub enabled: bool,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoSkillEntry {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSource {
    pub repo: String,
    pub branch: String,
    pub skills_path: String,
}

impl Default for SkillSource {
    fn default() -> Self {
        Self {
            repo: "anthropics/skills".to_string(),
            branch: "main".to_string(),
            skills_path: "skills/".to_string(),
        }
    }
}
