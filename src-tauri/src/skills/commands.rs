use super::adapters;
use super::db;
use super::ssot;
use super::types::{Skill, SkillApps};
use crate::AppState;
use tauri::State;

fn skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".claude")
        .join("skills")
}

fn agents_skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".agents")
        .join("skills")
}

/// Scan a single skills directory and register all skills with SKILL.md found there.
/// Returns (directory, ssot_path) for each newly-discovered skill — the ssot_path is what the
/// caller needs to project the skill into agent dirs.
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
        // Skip symlinks to avoid re-discovering our own projections
        if std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        #[cfg(windows)]
        if junction::exists(&path).unwrap_or(false) {
            continue;
        }

        // Register newly-discovered skills (names not yet in DB) with all agents enabled.
        // Existing skills keep their user-configured preferences (helper dedups by name).
        match super::service::register_discovered_skill(
            db_guard,
            &name,
            &path,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
            },
        ) {
            Ok(Some((directory, ssot_path))) => discovered.push((directory, ssot_path)),
            Ok(None) => {} // already in DB, skip
            Err(e) => log::warn!(target: "skills_scan", "Failed to register '{}': {}", name, e),
        }
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
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");

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
        let install_path_str = match install_arr
            .first()
            .and_then(|i| i.get("installPath"))
            .and_then(|p| p.as_str())
        {
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
                apps: SkillApps {
                    claude: true,
                    ..Default::default()
                },
                disk_path: Some(skill_dir.to_string_lossy().to_string()),
                directory: skill_name.clone(),
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

    let deleted =
        db::delete_skill(&db_guard, &id).map_err(|e| format!("Failed to delete skill: {}", e))?;

    if deleted {
        let directory = if skill.directory.is_empty() {
            skill.name.clone()
        } else {
            skill.directory.clone()
        };

        // 1. Remove projections from all agent directories via adapters
        for app in adapters::all_apps() {
            if let Some(adapter) = adapters::get_adapter(app) {
                if adapter.should_sync() {
                    let _ = adapter.remove_skill(&directory);
                }
            }
        }

        // 2. Remove the source skill directory from SSOT (~/.codemux/skills/<dir>)
        //    so we don't leave behind an empty folder after the user uninstalls.
        let ssot_dir = ssot::get_ssot_dir();
        let ssot_skill_dir = ssot_dir.join(&directory);
        if ssot_skill_dir.exists() {
            let _ = std::fs::remove_dir_all(&ssot_skill_dir);
        }

        // 3. If disk_path points elsewhere (e.g. legacy ~/.claude/skills/<name>),
        //    remove that too so we don't leave orphaned folders.
        if let Some(ref disk_path) = skill.disk_path {
            let p = std::path::PathBuf::from(disk_path);
            // Avoid double-removing the SSOT dir we just deleted
            if p != ssot_skill_dir && p.exists() {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub fn toggle_skill(state: State<'_, AppState>, id: String, enabled: bool) -> Result<bool, String> {
    // Legacy wrapper — delegates to toggle_skill_app with app="claude"
    super::service::toggle_app(state.inner(), &id, "claude", enabled)?;
    Ok(enabled)
}

#[tauri::command]
pub fn toggle_skill_app(
    state: State<'_, AppState>,
    skill_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    super::service::toggle_app(state.inner(), &skill_id, &app, enabled)
}

#[tauri::command]
pub fn list_importable_skills(
    state: State<'_, AppState>,
) -> Result<Vec<super::types::ImportableSkill>, String> {
    super::service::list_importable(state.inner())
}

#[tauri::command]
pub fn import_skills_from_apps(
    state: State<'_, AppState>,
    selected: Option<Vec<String>>,
) -> Result<super::service::ImportResult, String> {
    super::service::import_from_apps(state.inner(), selected)
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
    let search_name = skill.name.split(':').next_back().unwrap_or(&skill.name);
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
pub fn scan_disk_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    // Always re-scan the source directories for NEW skills (names not yet in the DB).
    // The first-time SSOT migration still runs only when the DB is empty.
    let mut to_sync: Vec<(String, std::path::PathBuf)> = Vec::new();
    {
        let db_guard = state.db.lock().unwrap();
        let existing =
            db::list_skills(&db_guard).map_err(|e| format!("Failed to list skills: {}", e))?;
        if existing.is_empty() {
            // First-time init: run SSOT migration (non-destructive: original files preserved)
            let _ = ssot::migrate_to_ssot(&db_guard);
        }

        // Scan disk directories for new skills
        for base in &[skills_dir(), agents_skills_dir()] {
            to_sync.extend(scan_skills_directory(&db_guard, base));
        }

        // Scan installed plugins for skills (e.g. superpowers:brainstorming).
        // Plugin skills stay claude-only and are not projected; the result is dropped —
        // newly-discovered plugin skills are picked up by the final list_skills below.
        drop(scan_plugin_skills(&db_guard));
    } // DB lock released before filesystem projection below

    // Project each newly-discovered skill into every installed agent's skills dir.
    // Matches service::toggle_app: filesystem ops happen after the DB lock is dropped.
    for (directory, ssot_source) in &to_sync {
        for app in adapters::all_apps() {
            if let Some(adapter) = adapters::get_adapter(app) {
                if adapter.should_sync() {
                    if let Err(e) = adapter.sync_skill(directory, ssot_source) {
                        log::warn!(
                            target: "skills_scan",
                            "Failed to sync skill '{}' to {}: {}",
                            directory,
                            app,
                            e
                        );
                    }
                }
            }
        }
    }

    // Return the full current list (plugin + disk + pre-existing).
    let db_guard = state.db.lock().unwrap();
    db::list_skills(&db_guard).map_err(|e| format!("Failed to list skills: {}", e))
}

#[tauri::command]
pub fn register_skill_from_disk(state: State<'_, AppState>, name: String) -> Result<Skill, String> {
    let db_guard = state.db.lock().unwrap();
    // Search both directories
    let dir =
        find_skill_path(&name).ok_or_else(|| format!("Skill '{}' not found on disk", name))?;
    db::register_skill_from_disk(&db_guard, dir.parent().unwrap_or(&dir), &name)
        .map_err(|e| format!("Failed to register skill from disk: {}", e))
}

#[tauri::command]
pub fn get_enabled_skill_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db_guard = state.db.lock().unwrap();
    db::get_enabled_skill_names(&db_guard)
        .map_err(|e| format!("Failed to get enabled skills: {}", e))
}
