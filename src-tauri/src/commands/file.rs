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

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// List directory contents as a tree structure.
/// Excludes common large/hidden directories. Default depth = 2.
#[tauri::command]
pub fn list_directory(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let max_depth = depth.unwrap_or(2);
    list_dir_recursive(&dir, max_depth)
}

fn list_dir_recursive(dir: &std::path::Path, remaining_depth: u32) -> Result<Vec<FileNode>, String> {
    let excluded = [
        ".git", "node_modules", "target", ".next", "dist",
        ".venv", "__pycache__", ".turbo", ".cache", "build",
    ];

    let mut entries: Vec<FileNode> = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if excluded.contains(&file_name.as_str()) {
            continue;
        }
        // Skip hidden files/dirs (starting with .)
        if file_name.starts_with('.') && file_name != ".env" {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();
        let path_str = path.to_string_lossy().to_string();

        let children = if is_dir && remaining_depth > 0 {
            Some(list_dir_recursive(&path, remaining_depth - 1)?)
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
