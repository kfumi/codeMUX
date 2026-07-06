use crate::skills::adapters;
use crate::skills::db;
use crate::skills::ssot;
use crate::skills::types::{ImportableSkill, SkillApps};
use crate::AppState;

/// Result of importing skills from agent directories.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub claude: usize,
    pub codex: usize,
    pub gemini: usize,
    pub opencode: usize,
    pub total: usize,
}

/// Toggle a skill's enable state for a specific agent app.
/// Updates DB and syncs/removes the skill directory from the agent's skills dir.
pub fn toggle_app(
    state: &AppState,
    skill_id: &str,
    app: &str,
    enabled: bool,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    // Get the skill
    let skill = db::get_skill(&conn, skill_id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    // Update DB
    db::set_skill_app_enabled(&conn, skill_id, app, enabled)
        .map_err(|e| format!("Failed to toggle skill app: {}", e))?;

    // Sync/remove from agent directory
    let directory = if skill.directory.is_empty() {
        skill.name.clone()
    } else {
        skill.directory.clone()
    };

    let source_path = skill
        .disk_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| ssot::get_ssot_dir().join(&directory));

    drop(conn);

    if let Some(adapter) = adapters::get_adapter(app) {
        if adapter.should_sync() {
            if enabled {
                if let Err(e) = adapter.sync_skill(&directory, &source_path) {
                    log::warn!(
                        target: "skills_sync",
                        "Failed to sync skill '{}' to {}: {}",
                        skill.name,
                        app,
                        e
                    );
                }
            } else if let Err(e) = adapter.remove_skill(&directory) {
                log::warn!(
                    target: "skills_sync",
                    "Failed to remove skill '{}' from {}: {}",
                    skill.name,
                    app,
                    e
                );
            }
        }
    }

    Ok(())
}

/// Scan all agent directories for unmanaged skills (not yet in DB).
/// Returns a list grouped by source app, without importing them.
/// Used by the import preview dialog to let the user choose which skills to import.
pub fn list_importable(state: &AppState) -> Result<Vec<ImportableSkill>, String> {
    let conn = state.db.lock().unwrap();

    let existing_skills =
        db::list_skills(&conn).map_err(|e| format!("Failed to list skills: {}", e))?;
    let existing_names: std::collections::HashSet<String> =
        existing_skills.iter().map(|s| s.name.clone()).collect();

    let mut result = Vec::new();

    for app in adapters::all_apps() {
        let Some(adapter) = adapters::get_adapter(app) else {
            continue;
        };
        if !adapter.should_sync() {
            continue;
        }

        let app_skills_dir = adapter.get_skills_dir();
        if !app_skills_dir.exists() {
            continue;
        }

        let entries = match std::fs::read_dir(&app_skills_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Skip symlinks/junctions (they're projections, not sources)
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

            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };

            if existing_names.contains(&name) {
                continue;
            }

            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let (description, display_name) = db::parse_frontmatter(&content);

            result.push(ImportableSkill {
                name,
                display_name,
                description,
                source_app: app.to_string(),
                disk_path: path.to_string_lossy().to_string(),
            });
        }
    }

    Ok(result)
}

/// Import skills from agent directories into SSOT.
/// If `selected` is None, imports all importable skills.
/// If `selected` is Some(names), imports only those skills.
/// Each imported skill gets the source agent's app enabled by default.
pub fn import_from_apps(
    state: &AppState,
    selected: Option<Vec<String>>,
) -> Result<ImportResult, String> {
    let conn = state.db.lock().unwrap();
    let ssot_dir = ssot::get_ssot_dir();

    let mut result = ImportResult {
        claude: 0,
        codex: 0,
        gemini: 0,
        opencode: 0,
        total: 0,
    };

    // Get all existing skill names for dedup
    let existing_skills =
        db::list_skills(&conn).map_err(|e| format!("Failed to list skills: {}", e))?;
    let existing_names: std::collections::HashSet<String> =
        existing_skills.iter().map(|s| s.name.clone()).collect();

    let selected_set: Option<std::collections::HashSet<String>> =
        selected.map(|s| s.into_iter().collect());

    for app in adapters::all_apps() {
        let Some(adapter) = adapters::get_adapter(app) else {
            continue;
        };
        if !adapter.should_sync() {
            continue;
        }

        let app_skills_dir = adapter.get_skills_dir();
        if !app_skills_dir.exists() {
            continue;
        }

        let entries = match std::fs::read_dir(&app_skills_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Skip symlinks/junctions (they're projections, not sources)
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
            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };

            // Skip if already in DB
            if existing_names.contains(&name) {
                continue;
            }

            // Skip if not in selected list (when a selection is provided)
            if let Some(ref sel) = selected_set {
                if !sel.contains(&name) {
                    continue;
                }
            }

            // Copy to SSOT
            let ssot_target = ssot_dir.join(&name);
            if !ssot_target.exists() {
                if let Err(e) = ssot::copy_dir_recursive(&path, &ssot_target) {
                    log::warn!(
                        target: "skills_import",
                        "Failed to copy {} to SSOT: {}",
                        name,
                        e
                    );
                    continue;
                }
            }

            // Parse metadata
            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let (description, display_name) = db::parse_frontmatter(&content);

            // Build SkillApps with only the source app enabled
            let apps = match app {
                "claude" => SkillApps {
                    claude: true,
                    ..Default::default()
                },
                "codex" => SkillApps {
                    codex: true,
                    ..Default::default()
                },
                "gemini" => SkillApps {
                    gemini: true,
                    ..Default::default()
                },
                "opencode" => SkillApps {
                    opencode: true,
                    ..Default::default()
                },
                _ => SkillApps::default(),
            };

            let now = chrono::Utc::now().to_rfc3339();
            let skill = crate::skills::types::Skill {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.clone(),
                display_name,
                description,
                installed_at: now,
                apps,
                disk_path: Some(ssot_target.to_string_lossy().to_string()),
                directory: name.clone(),
            };

            if let Err(e) = db::upsert_skill(&conn, &skill) {
                log::warn!(
                    target: "skills_import",
                    "Failed to insert skill {}: {}",
                    name,
                    e
                );
                continue;
            }

            // Sync projection to the source agent's skills dir so the skill is usable immediately
            if let Err(e) = adapter.sync_skill(&name, &ssot_target) {
                log::warn!(
                    target: "skills_import",
                    "Failed to sync imported skill '{}' to {}: {}",
                    name,
                    app,
                    e
                );
            }

            match app {
                "claude" => result.claude += 1,
                "codex" => result.codex += 1,
                "gemini" => result.gemini += 1,
                "opencode" => result.opencode += 1,
                _ => {}
            }
            result.total += 1;
        }
    }

    Ok(result)
}
