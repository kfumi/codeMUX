use serde::Serialize;
use tauri::AppHandle;

/// Open a directory in the system file explorer.
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(_app: AppHandle, path: String) -> Result<String, String> {
    // Resolve relative to the app's current working directory
    let base = std::env::current_dir().map_err(|e| e.to_string())?;
    let full_path = base.join(&path);

    // Security: ensure the resolved path is under the base directory
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// List directory contents as a tree structure.
/// Excludes common large/hidden directories. Default depth = 2, max depth = 5.
#[tauri::command]
pub fn list_directory(_app: AppHandle, path: String, base_path: Option<String>, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    // Use provided base_path as security base, or fall back to current_dir
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };
    let canonical_base = base.canonicalize().map_err(|e| format!("Base path not found: {}", e))?;

    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = dir.canonicalize().map_err(|e| format!("Path not found: {}", e))?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    // Cap depth at 5 to prevent huge responses
    let max_depth = depth.unwrap_or(2).min(5);
    list_dir_recursive(&canonical, max_depth, &canonical_base)
}

fn list_dir_recursive(dir: &std::path::Path, remaining_depth: u32, canonical_base: &std::path::Path) -> Result<Vec<FileNode>, String> {
    let excluded = [
        ".git", "node_modules", "target", ".next", "dist",
        ".venv", "__pycache__", ".turbo", ".cache", "build",
    ];

    let mut entries: Vec<FileNode> = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        // Skip entries that can't be read (permission denied, etc.)
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();

        if excluded.contains(&file_name.as_str()) {
            continue;
        }
        // Skip all hidden files/dirs (starting with .)
        if file_name.starts_with('.') {
            continue;
        }

        let path = entry.path();

        // Use symlink_metadata to detect symlinks and skip them (prevents symlink traversal)
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        let is_dir = metadata.is_dir();

        // Security: canonicalize and verify each child stays within the base directory
        if is_dir {
            if let Ok(canonical_child) = path.canonicalize() {
                if !canonical_child.starts_with(canonical_base) {
                    continue;
                }
            }
        }

        // Normalize path to forward slashes for cross-platform frontend compatibility
        let path_str = path.to_string_lossy().replace('\\', "/");

        let children = if is_dir && remaining_depth > 0 {
            Some(list_dir_recursive(&path, remaining_depth - 1, canonical_base)?)
        } else {
            None
        };

        entries.push(FileNode {
            name: file_name,
            path: path_str,
            is_dir,
            children,
        });
    }

    // Sort: directories first, then files, each alphabetically
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}
