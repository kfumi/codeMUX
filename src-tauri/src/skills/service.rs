use crate::skills::adapters;
use crate::skills::db;
use crate::skills::ssot;
use crate::skills::types::{ImportableSkill, Skill, SkillApps};
use crate::AppState;
use std::path::{Path, PathBuf};

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

/// Register a skill discovered on disk into SSOT + DB.
///
/// - Copies the source dir to `~/.codemux/skills/<name>` (non-destructive: skips if the target already exists).
/// - Parses `SKILL.md` frontmatter for description/display_name.
/// - Upserts a skill row with the given `apps` enablement and `disk_path` pointing at SSOT.
///
/// Returns `Some((directory, ssot_path))` when a new skill was inserted, or `None` when a skill
/// with this name already exists in the DB (caller skips it). The returned `ssot_path` is what the
/// caller needs to project the skill into agent dirs.
pub fn register_discovered_skill(
    conn: &rusqlite::Connection,
    name: &str,
    source_path: &Path,
    apps: SkillApps,
) -> Result<Option<(String, PathBuf)>, String> {
    // Dedup: never overwrite an existing skill's user preferences.
    if db::get_skill_by_name(conn, name)
        .map_err(|e| format!("Failed to look up skill '{}': {}", name, e))?
        .is_some()
    {
        return Ok(None);
    }

    let ssot_dir = ssot::get_ssot_dir();
    let ssot_target = ssot_dir.join(name);

    // Copy to SSOT if not already there (non-destructive).
    if !ssot_target.exists() {
        ssot::copy_dir_recursive(source_path, &ssot_target)
            .map_err(|e| format!("Failed to copy '{}' to SSOT: {}", name, e))?;
    }

    // Parse metadata from the source SKILL.md.
    let skill_md = source_path.join("SKILL.md");
    let (description, display_name) = if skill_md.exists() {
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        db::parse_frontmatter(&content)
    } else {
        (None, None)
    };

    let now = chrono::Utc::now().to_rfc3339();
    let skill = Skill {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        display_name,
        description,
        installed_at: now,
        apps,
        disk_path: Some(ssot_target.to_string_lossy().into_owned()),
        directory: name.to_string(),
    };

    db::upsert_skill(conn, &skill)
        .map_err(|e| format!("Failed to upsert skill '{}': {}", name, e))?;

    Ok(Some((name.to_string(), ssot_target)))
}

#[cfg(test)]
mod tests {
    use super::register_discovered_skill;
    use crate::db::schema::initialize_database;
    use crate::skills::db;
    use crate::skills::ssot;
    use crate::skills::types::{Skill, SkillApps};
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    // get_ssot_dir() resolves the home dir from env vars, so tests that touch the SSOT
    // dir must serialize on a single global lock to avoid stepping on each other.
    // Locking is poison-tolerant: if a previous test panicked mid-flight, later tests
    // still acquire the lock instead of cascading into PoisonError failures.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Build a temp "home" tree and point USERPROFILE/HOME at it so SSOT lands inside.
    fn setup_temp_home(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let home = std::env::temp_dir().join(format!(
            ".codemux-test-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("HOME", &home);
        home
    }

    fn write_skill_md(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn register_discovered_skill_inserts_all_apps_enabled_and_copies_to_ssot() {
        let _guard = env_lock();
        let home = setup_temp_home("all_apps");
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let source = home.join("source").join("my-skill");
        write_skill_md(
            &source,
            "---\nname: My Skill\ndescription: does a thing\n---\n# body\n",
        );

        let result = register_discovered_skill(
            &conn,
            "my-skill",
            &source,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
            },
        )
        .unwrap();

        let (directory, ssot_path) = result.expect("expected a newly-inserted skill");
        assert_eq!(directory, "my-skill");
        assert!(ssot_path.ends_with(std::path::Path::new(".codemux/skills/my-skill")));
        assert!(
            ssot_path.join("SKILL.md").exists(),
            "SSOT copy should exist"
        );

        let skill = db::get_skill_by_name(&conn, "my-skill")
            .unwrap()
            .expect("skill row should exist");
        assert!(skill.apps.claude);
        assert!(skill.apps.codex);
        assert!(skill.apps.gemini);
        assert!(skill.apps.opencode);
        assert_eq!(skill.display_name.as_deref(), Some("My Skill"));
        assert_eq!(skill.description.as_deref(), Some("does a thing"));
        assert!(skill
            .disk_path
            .as_ref()
            .is_some_and(|p| std::path::Path::new(p).ends_with(".codemux/skills/my-skill")));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn register_discovered_skill_returns_none_when_name_exists() {
        let _guard = env_lock();
        let home = setup_temp_home("exists");
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        // Pre-existing skill, claude-only (user preference) — must NOT be clobbered.
        let now = chrono::Utc::now().to_rfc3339();
        let existing = Skill {
            id: uuid::Uuid::new_v4().to_string(),
            name: "pre-existing".to_string(),
            display_name: None,
            description: None,
            installed_at: now,
            apps: SkillApps {
                claude: true,
                codex: false,
                gemini: false,
                opencode: false,
            },
            disk_path: None,
            directory: "pre-existing".to_string(),
        };
        db::upsert_skill(&conn, &existing).unwrap();

        let source = home.join("source").join("pre-existing");
        write_skill_md(&source, "---\nname: Pre\ndescription: new\n---\n");

        let result = register_discovered_skill(
            &conn,
            "pre-existing",
            &source,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
            },
        )
        .unwrap();
        assert!(result.is_none(), "should skip when name already exists");

        // Existing preferences untouched.
        let skill = db::get_skill_by_name(&conn, "pre-existing")
            .unwrap()
            .unwrap();
        assert!(skill.apps.claude);
        assert!(!skill.apps.codex);
        assert!(!skill.apps.gemini);
        assert!(!skill.apps.opencode);
        assert_eq!(
            skill.description, None,
            "existing row must not be overwritten"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn register_discovered_skill_is_idempotent_on_ssot_dir() {
        let _guard = env_lock();
        let home = setup_temp_home("idempotent");
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        // SSOT target already exists (e.g. left over from a previous run).
        let ssot_dir = ssot::get_ssot_dir();
        let ssot_target = ssot_dir.join("leftover");
        write_skill_md(&ssot_target, "---\nname: Leftover\n---\nleftover content\n");

        let source = home.join("source").join("leftover");
        write_skill_md(
            &source,
            "---\nname: Leftover\ndescription: src\n---\nsource content\n",
        );

        let result = register_discovered_skill(
            &conn,
            "leftover",
            &source,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
            },
        )
        .unwrap();

        let (_, returned_path) = result.expect("should still insert when SSOT dir exists");
        assert_eq!(returned_path, ssot_target);

        let _ = std::fs::remove_dir_all(&home);
    }
}
