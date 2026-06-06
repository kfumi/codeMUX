use tauri::State;
use crate::AppState;
use super::types::{Skill, RepoSkillEntry, SkillSource};
use super::db;
use super::github;
use super::builtin;

fn skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home).join(".claude").join("skills")
}

#[tauri::command]
pub fn list_installed_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    let db = state.db.lock().unwrap();
    db::list_skills(&db).map_err(|e| format!("Failed to list skills: {}", e))
}

#[tauri::command]
pub async fn browse_repo_skills(
    state: State<'_, AppState>,
    repo: String,
    branch: Option<String>,
    path: Option<String>,
) -> Result<Vec<RepoSkillEntry>, String> {
    let source = SkillSource {
        repo,
        branch: branch.unwrap_or_else(|| "main".to_string()),
        skills_path: path.unwrap_or_else(|| "skills/".to_string()),
    };

    let installed_names = {
        let db = state.db.lock().unwrap();
        db::list_skills(&db)
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.name)
            .collect::<Vec<_>>()
    };

    github::browse_repo_skills(&source, &installed_names).await
}

#[tauri::command]
pub async fn install_skill(
    state: State<'_, AppState>,
    repo: String,
    _branch: String,
    path: String,
    name: String,
) -> Result<Skill, String> {
    let files = github::download_skill_files(&repo, &path).await?;

    let skill_dir = skills_dir().join(&name);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    for (filename, content) in &files {
        let file_path = skill_dir.join(filename);
        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write {}: {}", filename, e))?;
    }

    let skill_md_content = files.iter()
        .find(|(name, _)| name == "SKILL.md")
        .map(|(_, content)| content.as_str())
        .unwrap_or("");
    let (description, display_name) = db::parse_frontmatter(skill_md_content);

    let now = chrono::Utc::now().to_rfc3339();
    let db_guard = state.db.lock().unwrap();
    let existing = db::get_skill_by_name(&db_guard, &name).unwrap_or(None);
    let skill = Skill {
        id: existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.clone(),
        display_name,
        description,
        source_repo: Some(repo),
        source_path: Some(path),
        version: None,
        installed_at: now,
        enabled: existing.as_ref().map(|s| s.enabled).unwrap_or(true),
        is_builtin: false,
    };
    db::upsert_skill(&db_guard, &skill).map_err(|e| format!("Failed to save skill: {}", e))?;
    Ok(skill)
}

#[tauri::command]
pub fn uninstall_skill(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db_guard = state.db.lock().unwrap();
    let skill = db::get_skill(&db_guard, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    if skill.is_builtin {
        return Err("Cannot uninstall builtin skills".to_string());
    }

    let deleted = db::delete_skill(&db_guard, &id)
        .map_err(|e| format!("Failed to delete skill: {}", e))?;

    if deleted {
        let skill_dir = skills_dir().join(&skill.name);
        if skill_dir.exists() {
            let _ = std::fs::remove_dir_all(&skill_dir);
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub fn toggle_skill(state: State<'_, AppState>, id: String, enabled: bool) -> Result<bool, String> {
    let db_guard = state.db.lock().unwrap();
    db::update_skill_enabled(&db_guard, &id, enabled)
        .map_err(|e| format!("Failed to toggle skill: {}", e))?;
    Ok(enabled)
}

#[tauri::command]
pub fn get_skill_content(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let db_guard = state.db.lock().unwrap();
    let skill = db::get_skill(&db_guard, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    let skill_md = skills_dir().join(&skill.name).join("SKILL.md");
    if skill_md.exists() {
        std::fs::read_to_string(&skill_md)
            .map_err(|e| format!("Failed to read SKILL.md: {}", e))
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn sync_builtin_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    let db_guard = state.db.lock().unwrap();
    let dir = skills_dir();

    let builtins = [
        ("find-skills", builtin::FIND_SKILLS_CONTENT),
        ("skill-creator", builtin::SKILL_CREATOR_CONTENT),
    ];

    let mut result = Vec::new();
    for (name, fallback_content) in &builtins {
        let skill_dir = dir.join(name);
        let skill_md = skill_dir.join("SKILL.md");

        if !skill_md.exists() {
            let _ = std::fs::create_dir_all(&skill_dir);
            let _ = std::fs::write(&skill_md, fallback_content);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let (description, display_name) = if skill_md.exists() {
            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            db::parse_frontmatter(&content)
        } else {
            (None, None)
        };

        let existing = db::get_skill_by_name(&db_guard, name).unwrap_or(None);
        let skill = Skill {
            id: existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: name.to_string(),
            display_name,
            description,
            source_repo: Some("anthropics/skills".to_string()),
            source_path: Some(format!("skills/{}", name)),
            version: None,
            installed_at: existing.as_ref().map(|s| s.installed_at.clone()).unwrap_or_else(|| now.clone()),
            enabled: existing.as_ref().map(|s| s.enabled).unwrap_or(true),
            is_builtin: true,
        };
        let _ = db::upsert_skill(&db_guard, &skill);
        result.push(skill);
    }
    Ok(result)
}

#[tauri::command]
pub fn register_skill_from_disk(state: State<'_, AppState>, name: String) -> Result<Skill, String> {
    let db_guard = state.db.lock().unwrap();
    let dir = skills_dir();
    db::register_skill_from_disk(&db_guard, &dir, &name)
        .map_err(|e| format!("Failed to register skill from disk: {}", e))
}

#[tauri::command]
pub fn get_skill_sources() -> Result<Vec<SkillSource>, String> {
    Ok(vec![SkillSource::default()])
}

#[tauri::command]
pub fn get_enabled_skill_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db_guard = state.db.lock().unwrap();
    db::get_enabled_skill_names(&db_guard).map_err(|e| format!("Failed to get enabled skills: {}", e))
}
