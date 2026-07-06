use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Get the SSOT directory for skills: ~/.codemux/skills/
/// Creates the directory if it doesn't exist.
pub fn get_ssot_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let dir = PathBuf::from(home).join(".codemux").join("skills");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

/// Check if a path is under the SSOT directory.
fn is_in_ssot(path: &Path) -> bool {
    let ssot = get_ssot_dir();
    path.starts_with(&ssot)
}

/// Migrate skills from ~/.claude/skills/ and ~/.agents/skills/ to SSOT.
/// Non-destructive: copies files, doesn't remove originals.
/// Skips plugin skills (name contains ":") and skills already in SSOT.
/// Updates disk_path in DB to point to SSOT.
pub fn migrate_to_ssot(conn: &Connection) -> Result<(), String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    let home = PathBuf::from(home);
    let ssot = get_ssot_dir();

    // Source directories to scan
    let source_dirs = [
        home.join(".claude").join("skills"),
        home.join(".agents").join("skills"),
    ];

    // Get all skills from DB
    let skills = crate::skills::db::list_skills(conn)
        .map_err(|e| format!("Failed to list skills: {}", e))?;

    for skill in &skills {
        // Skip plugin skills (name contains ":")
        if skill.name.contains(':') {
            continue;
        }

        // Skip if disk_path already points to SSOT
        if let Some(ref disk_path) = skill.disk_path {
            if is_in_ssot(Path::new(disk_path)) {
                continue;
            }
        }

        // Find the source directory
        let directory = if skill.directory.is_empty() {
            skill.name.clone()
        } else {
            skill.directory.clone()
        };

        // Try to find the skill in source dirs
        let mut found_source: Option<PathBuf> = None;
        for source_dir in &source_dirs {
            let candidate = source_dir.join(&directory);
            if candidate.join("SKILL.md").exists() {
                found_source = Some(candidate);
                break;
            }
        }

        // Also check the current disk_path
        if found_source.is_none() {
            if let Some(ref disk_path) = skill.disk_path {
                let p = PathBuf::from(disk_path);
                if p.join("SKILL.md").exists() {
                    found_source = Some(p);
                }
            }
        }

        let Some(source) = found_source else {
            continue;
        };

        // Copy to SSOT if not already there
        let ssot_target = ssot.join(&directory);
        if !ssot_target.exists() {
            copy_dir_recursive(&source, &ssot_target)
                .map_err(|e| format!("Failed to copy {} to SSOT: {}", skill.name, e))?;
        }

        // Update disk_path in DB
        let new_path = ssot_target.to_string_lossy().to_string();
        conn.execute(
            "UPDATE skills SET disk_path = ?1 WHERE id = ?2",
            rusqlite::params![new_path, skill.id],
        )
        .map_err(|e| format!("Failed to update disk_path: {}", e))?;

        log::info!(
            target: "skills_ssot",
            "Migrated skill '{}' to SSOT: {}",
            skill.name,
            new_path
        );
    }

    Ok(())
}

/// Recursively copy a directory tree.
/// Skips symlinks to avoid cycles.
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if file_type.is_symlink() {
            // Skip symlinks to avoid cycles
            continue;
        }
        if file_type.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}
