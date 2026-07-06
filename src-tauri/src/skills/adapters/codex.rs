use std::path::PathBuf;

use crate::skills::adapter::{
    remove_skill_impl, sync_skill_impl, SkillAdapter, SkillAdapterResult,
};

fn home_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home)
}

fn codex_skills_dir() -> PathBuf {
    home_dir().join(".codex").join("skills")
}

pub struct CodexSkillAdapter;

impl SkillAdapter for CodexSkillAdapter {
    fn should_sync(&self) -> bool {
        home_dir().join(".codex").exists()
    }

    fn get_skills_dir(&self) -> PathBuf {
        codex_skills_dir()
    }

    fn sync_skill(&self, directory: &str, source: &std::path::Path) -> SkillAdapterResult<()> {
        sync_skill_impl(&codex_skills_dir(), directory, source)
    }

    fn remove_skill(&self, directory: &str) -> SkillAdapterResult<()> {
        remove_skill_impl(&codex_skills_dir(), directory)
    }
}
