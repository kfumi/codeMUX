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

fn opencode_skills_dir() -> PathBuf {
    home_dir().join(".config").join("opencode").join("skills")
}

pub struct OpenCodeSkillAdapter;

impl SkillAdapter for OpenCodeSkillAdapter {
    fn should_sync(&self) -> bool {
        home_dir().join(".config").join("opencode").exists()
    }

    fn get_skills_dir(&self) -> PathBuf {
        opencode_skills_dir()
    }

    fn sync_skill(&self, directory: &str, source: &std::path::Path) -> SkillAdapterResult<()> {
        sync_skill_impl(&opencode_skills_dir(), directory, source)
    }

    fn remove_skill(&self, directory: &str) -> SkillAdapterResult<()> {
        remove_skill_impl(&opencode_skills_dir(), directory)
    }
}
