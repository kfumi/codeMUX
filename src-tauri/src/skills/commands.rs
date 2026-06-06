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

fn agents_skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home).join(".agents").join("skills")
}

/// Scan a single skills directory and register all skills with SKILL.md found there.
/// Returns (name, skill_dir_path) for each discovered skill.
fn scan_skills_directory(
    db_guard: &rusqlite::Connection,
    dir: &std::path::Path,
) -> Vec<(String, std::path::PathBuf)> {
    let mut discovered = Vec::new();
    if !dir.exists() || !dir.is_dir() {
        return discovered;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return discovered,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip symlinks to avoid duplicates
        if std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let (description, display_name) = db::parse_frontmatter(&content);

        // Only register if not already in DB (don't overwrite user preferences)
        let existing = db::get_skill_by_name(db_guard, &name).unwrap_or(None);
        if existing.is_some() {
            discovered.push((name, path));
            continue;
        }

        let now = chrono::Utc::now().to_rfc3339();
        let skill = Skill {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.clone(),
            display_name,
            description,
            installed_at: now,
            enabled: true,
            is_builtin: false,
            disk_path: Some(path.to_string_lossy().to_string()),
        };
        let _ = db::upsert_skill(db_guard, &skill);
        discovered.push((name, path));
    }
    discovered
}

/// Search all known skill directories for a SKILL.md matching the given name.
fn find_skill_path(name: &str) -> Option<std::path::PathBuf> {
    let candidates = [skills_dir(), agents_skills_dir()];
    for base in &candidates {
        let path = base.join(name).join("SKILL.md");
        if path.exists() {
            return Some(base.join(name));
        }
    }
    None
}

/// Scan installed Claude Code plugins for skills.
/// Reads ~/.claude/plugins/installed_plugins.json, finds all SKILL.md files
/// in each plugin's installPath, and registers them with prefixed names
/// like "superpowers:brainstorming".
fn scan_plugin_skills(db_guard: &rusqlite::Connection) -> Vec<Skill> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let manifest_path = std::path::PathBuf::from(&home)
        .join(".claude").join("plugins").join("installed_plugins.json");

    let manifest_content = match std::fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let manifest: serde_json::Value = match serde_json::from_str(&manifest_content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let plugins = match manifest.get("plugins").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return Vec::new(),
    };

    let mut result = Vec::new();

    for (plugin_key, installs) in plugins {
        // Extract short name: "superpowers@claude-plugins-official" → "superpowers"
        let short_name = plugin_key.split('@').next().unwrap_or(plugin_key);

        let install_arr = match installs.as_array() {
            Some(a) => a,
            None => continue,
        };

        // Use the latest install (first entry)
        let install_path_str = match install_arr.first().and_then(|i| i.get("installPath")).and_then(|p| p.as_str()) {
            Some(p) => p,
            None => continue,
        };
        let install_path = std::path::PathBuf::from(install_path_str);
        if !install_path.exists() {
            continue;
        }

        // Scan for SKILL.md files: check skills/ subdirectory first, then root
        let skills_dir_path = install_path.join("skills");
        let scan_dirs: Vec<std::path::PathBuf> = if skills_dir_path.exists() {
            // Each subdirectory in skills/ is a skill
            std::fs::read_dir(&skills_dir_path)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect()
        } else {
            // The plugin root itself might be a skill
            vec![install_path.clone()]
        };

        for skill_dir in scan_dirs {
            let skill_md = skill_dir.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let skill_name = match skill_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };

            // Prefixed name for SDK: "superpowers:brainstorming"
            let prefixed_name = format!("{}:{}", short_name, skill_name);

            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let (description, display_name) = db::parse_frontmatter(&content);

            let existing = db::get_skill_by_name(db_guard, &prefixed_name).unwrap_or(None);
            if let Some(existing_skill) = existing {
                result.push(existing_skill);
                continue;
            }

            let now = chrono::Utc::now().to_rfc3339();
            let skill = Skill {
                id: uuid::Uuid::new_v4().to_string(),
                name: prefixed_name.clone(),
                display_name,
                description,
                installed_at: now,
                enabled: true,
                is_builtin: false,
                disk_path: Some(skill_dir.to_string_lossy().to_string()),
            };
            let _ = db::upsert_skill(db_guard, &skill);
            result.push(skill);
        }
    }

    result
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
        // Try to remove from all known directories
        for base in &[skills_dir(), agents_skills_dir()] {
            let skill_dir = base.join(&skill.name);
            if skill_dir.exists() {
                let _ = std::fs::remove_dir_all(&skill_dir);
            }
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

    // Use stored disk_path if available (plugin skills, disk skills)
    if let Some(ref disk_path) = skill.disk_path {
        let skill_md = std::path::PathBuf::from(disk_path).join("SKILL.md");
        if skill_md.exists() {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }
    }

    // Fallback: search known directories by name
    // For prefixed names like "superpowers:brainstorming", extract the skill name part
    let search_name = skill.name.split(':').last().unwrap_or(&skill.name);
    if let Some(skill_dir) = find_skill_path(search_name) {
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }
    }
    Ok(String::new())
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
            disk_path: Some(skill_dir.to_string_lossy().to_string()),
        };
        let _ = db::upsert_skill(&db_guard, &skill);
        result.push(skill);
    }

    // Scan disk directories for non-builtin skills
    let builtin_names: std::collections::HashSet<&str> = builtins.iter().map(|(n, _)| *n).collect();

    for base in &[skills_dir(), agents_skills_dir()] {
        let discovered = scan_skills_directory(&db_guard, base);
        for (name, _path) in discovered {
            if builtin_names.contains(name.as_str()) {
                continue;
            }
            if let Some(skill) = db::get_skill_by_name(&db_guard, &name).unwrap_or(None) {
                result.push(skill);
            }
        }
    }

    // Scan installed plugins for skills (e.g. superpowers:brainstorming)
    let plugin_skills = scan_plugin_skills(&db_guard);
    result.extend(plugin_skills);

    Ok(result)
}

#[tauri::command]
pub fn register_skill_from_disk(state: State<'_, AppState>, name: String) -> Result<Skill, String> {
    let db_guard = state.db.lock().unwrap();
    // Search both directories
    let dir = find_skill_path(&name)
        .ok_or_else(|| format!("Skill '{}' not found on disk", name))?;
    db::register_skill_from_disk(&db_guard, &dir.parent().unwrap_or(&dir), &name)
        .map_err(|e| format!("Failed to register skill from disk: {}", e))
}

#[tauri::command]
pub fn get_enabled_skill_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db_guard = state.db.lock().unwrap();
    db::get_enabled_skill_names(&db_guard).map_err(|e| format!("Failed to get enabled skills: {}", e))
}
