use tauri::State;
use crate::AppState;
use super::types::Skill;
use super::db;
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
    // Builtins are always enabled
    if let Some(skill) = db::get_skill(&db_guard, &id).map_err(|e| format!("Failed to get skill: {}", e))? {
        if skill.is_builtin && !enabled {
            return Err("Cannot disable builtin skills".to_string());
        }
    }
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
            installed_at: existing.as_ref().map(|s| s.installed_at.clone()).unwrap_or_else(|| now.clone()),
            enabled: true,  // Builtins are always enabled
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
pub fn get_enabled_skill_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db_guard = state.db.lock().unwrap();
    db::get_enabled_skill_names(&db_guard).map_err(|e| format!("Failed to get enabled skills: {}", e))
}
