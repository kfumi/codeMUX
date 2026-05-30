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
