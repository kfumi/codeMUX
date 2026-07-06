use std::path::{Path, PathBuf};

pub type SkillAdapterResult<T> = Result<T, String>;

pub trait SkillAdapter: Sync {
    /// Whether this tool is installed and we should sync to it
    fn should_sync(&self) -> bool;
    /// Get the skills directory for this agent (e.g. ~/.claude/skills/)
    fn get_skills_dir(&self) -> PathBuf;
    /// Sync a skill directory from source to this agent's skills dir.
    /// `directory` is the sanitized subdirectory name (single segment, no .. or /).
    /// `source` is the SSOT path (or plugin install path for plugin skills).
    fn sync_skill(&self, directory: &str, source: &Path) -> SkillAdapterResult<()>;
    /// Remove a skill directory from this agent's skills dir.
    fn remove_skill(&self, directory: &str) -> SkillAdapterResult<()>;
}

/// Sanitize a skill name into a valid single-segment directory name.
/// Rejects "..", absolute paths, multi-segment paths, and Windows prefix paths.
/// Replaces ":" with "-" (for plugin skills like "superpowers:brainstorming").
pub fn sanitize_directory_name(name: &str) -> Option<String> {
    let sanitized = name.replace(':', "-");
    let path = Path::new(&sanitized);
    let mut components = path.components();
    let first = components.next()?;
    // Only accept Normal components (rejects RootDir, ParentDir, etc.)
    match first {
        std::path::Component::Normal(_) => {}
        _ => return None,
    }
    // Reject multi-segment paths (only single segment allowed)
    if components.next().is_some() {
        return None;
    }
    // Reject names starting with '.'
    if sanitized.starts_with('.') {
        return None;
    }
    // Reject empty
    if sanitized.is_empty() {
        return None;
    }
    Some(sanitized)
}

/// Shared sync implementation: symlink preferred, copy fallback, atomic replace for existing real dirs.
pub fn sync_skill_impl(
    skills_dir: &Path,
    directory: &str,
    source: &Path,
) -> SkillAdapterResult<()> {
    // 1. Sanitize directory name
    let sanitized = sanitize_directory_name(directory).ok_or("Invalid skill directory name")?;

    // 2. Ensure skills_dir exists
    std::fs::create_dir_all(skills_dir)
        .map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let dest = skills_dir.join(&sanitized);

    // 3. Verify source contains SKILL.md
    let source_skill_md = source.join("SKILL.md");
    if !source_skill_md.exists() {
        return Err("Source directory does not contain SKILL.md".to_string());
    }

    // 4. Check if dest exists and is a symlink
    let dest_metadata = std::fs::symlink_metadata(&dest).ok();
    let dest_is_symlink = dest_metadata
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);

    if dest.exists() && !dest_is_symlink {
        // Dest is a real directory (user-placed files) — use atomic replace with copy
        replace_dest_with_copy(source, &dest, &sanitized)?;
        return Ok(());
    }

    // Dest doesn't exist or is a symlink — remove old symlink if exists
    if dest_is_symlink {
        remove_path(&dest)?;
    }

    // Try symlink first
    match create_symlink(source, &dest) {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!("symlink failed, falling back to copy: {}", err);
            replace_dest_with_copy(source, &dest, &sanitized)?;
            Ok(())
        }
    }
}

/// Shared remove implementation.
pub fn remove_skill_impl(skills_dir: &Path, directory: &str) -> SkillAdapterResult<()> {
    let sanitized = sanitize_directory_name(directory).ok_or("Invalid skill directory name")?;
    let dest = skills_dir.join(&sanitized);
    if dest.exists() {
        remove_path(&dest)?;
    }
    Ok(())
}

/// Create a symlink from `source` to `dest` (dest points to source).
#[cfg(unix)]
fn create_symlink(source: &Path, dest: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, dest).map_err(|e| format!("Failed to create symlink: {}", e))
}

#[cfg(windows)]
fn create_symlink(source: &Path, dest: &Path) -> Result<(), String> {
    // Try symlink first (requires developer mode or admin privileges).
    match std::os::windows::fs::symlink_dir(source, dest) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Symlink failed (typically os error 1314 — privilege not held).
            // Fall back to a junction, which works for directories without privileges.
            junction::create(source, dest).map_err(|je| {
                format!(
                    "Failed to create symlink: {} (junction fallback also failed: {})",
                    e, je
                )
            })
        }
    }
}

/// Remove a path that may be a symlink, a junction, or a real directory.
#[cfg(unix)]
fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path);
    match metadata {
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(path),
        Ok(_) => std::fs::remove_dir_all(path),
        Err(e) => return Err(format!("Failed to read metadata: {}", e)),
    }
    .map_err(|e| format!("Failed to remove path: {}", e))
}

#[cfg(windows)]
fn remove_path(path: &Path) -> Result<(), String> {
    // Junctions are reparse points but NOT reported as symlinks by is_symlink().
    // Check for junction first to avoid delete_dir_all following into the target.
    if junction::exists(path).unwrap_or(false) {
        return junction::delete(path).map_err(|e| format!("Failed to remove junction: {}", e));
    }
    let metadata = std::fs::symlink_metadata(path);
    match metadata {
        Ok(m) if m.file_type().is_symlink() => {
            // On Windows, directory symlinks require remove_dir, file symlinks require remove_file.
            // Follow the symlink to determine target type; fall back to trying both for dangling links.
            let is_dir_target = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
            if is_dir_target {
                std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path))
            } else {
                std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path))
            }
        }
        Ok(_) => std::fs::remove_dir_all(path),
        Err(e) => return Err(format!("Failed to read metadata: {}", e)),
    }
    .map_err(|e| format!("Failed to remove path: {}", e))
}

/// Atomically replace dest with a copy of source.
/// Copies source to a temp dir, then removes old dest and renames temp to dest.
fn replace_dest_with_copy(source: &Path, dest: &Path, name: &str) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;

    let pid = std::process::id();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_dir = parent.join(format!(".{}.tmp-{}-{}", name, pid, nonce));

    // Copy source to temp dir
    copy_dir_recursive(source, &tmp_dir)
        .map_err(|e| format!("Failed to copy source to temp dir: {}", e))?;

    // Remove old dest (symlink or real dir); also handle dangling symlinks
    if dest.exists() || std::fs::symlink_metadata(dest).is_ok() {
        remove_path(dest).map_err(|e| format!("Failed to remove old dest: {}", e))?;
    }

    // Rename temp dir to dest
    std::fs::rename(&tmp_dir, dest)
        .map_err(|e| format!("Failed to rename temp dir to dest: {}", e))?;

    Ok(())
}

/// Recursively copy a directory from src to dst.
/// Skips symlinked entries inside src to avoid cycles.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            // Skip symlinks inside source to avoid cycles
            continue;
        }
        if file_type.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_simple_name() {
        assert_eq!(
            sanitize_directory_name("my-skill"),
            Some("my-skill".to_string())
        );
    }

    #[test]
    fn sanitize_plugin_name() {
        assert_eq!(
            sanitize_directory_name("superpowers:brainstorming"),
            Some("superpowers-brainstorming".to_string())
        );
    }

    #[test]
    fn reject_parent_dir() {
        assert_eq!(sanitize_directory_name(".."), None);
    }

    #[test]
    fn reject_multi_segment() {
        assert_eq!(sanitize_directory_name("a/b"), None);
    }

    #[test]
    fn reject_empty() {
        assert_eq!(sanitize_directory_name(""), None);
    }

    #[test]
    fn reject_hidden() {
        assert_eq!(sanitize_directory_name(".hidden"), None);
    }

    #[test]
    fn reject_absolute_path() {
        assert_eq!(sanitize_directory_name("/abs/path"), None);
    }
}
