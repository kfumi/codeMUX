use log::{debug, info};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenProjectCommand {
    program: String,
    args: Vec<String>,
}

#[cfg(test)]
fn build_open_project_command(
    target: &str,
    path: &str,
    os: &str,
) -> Result<OpenProjectCommand, String> {
    build_open_project_commands(target, path, os)?
        .into_iter()
        .next()
        .ok_or_else(|| format!("Unsupported project open target: {}", target))
}

fn cmd_start_command(program: impl Into<String>, args: Vec<String>) -> OpenProjectCommand {
    let mut command_args = vec![
        "/C".to_string(),
        "start".to_string(),
        "".to_string(),
        program.into(),
    ];
    command_args.extend(args);
    OpenProjectCommand {
        program: "cmd".to_string(),
        args: command_args,
    }
}

fn env_path(var: &str, segments: &[&str]) -> Option<String> {
    let mut path = std::env::var_os(var).map(std::path::PathBuf::from)?;
    for segment in segments {
        path.push(segment);
    }
    Some(path.to_string_lossy().to_string())
}

fn push_unique_command(commands: &mut Vec<OpenProjectCommand>, command: OpenProjectCommand) {
    let program_path = std::path::Path::new(&command.program);
    if program_path.is_absolute() && !program_path.exists() {
        return;
    }

    if !commands
        .iter()
        .any(|candidate| candidate.program.eq_ignore_ascii_case(&command.program))
    {
        commands.push(command);
    }
}

fn windows_local_app_data_candidates() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(std::path::PathBuf::from(local_app_data));
    }

    let username = std::env::var_os("USERNAME")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var_os("USERPROFILE").and_then(|profile| {
                std::path::Path::new(&profile)
                    .file_name()
                    .map(|name| name.to_os_string())
            })
        });

    if let Some(username) = username {
        let username = username.to_string_lossy();
        for drive in 'C'..='Z' {
            roots.push(std::path::PathBuf::from(format!(
                "{}:\\Users\\{}\\AppData\\Local",
                drive, username
            )));
        }
    }

    roots.dedup();
    roots
}

fn push_windows_local_program(
    commands: &mut Vec<OpenProjectCommand>,
    program_segments: &[&str],
    args: Vec<String>,
) {
    for root in windows_local_app_data_candidates() {
        let mut program = root;
        for segment in program_segments {
            program.push(segment);
        }
        push_unique_command(
            commands,
            OpenProjectCommand {
                program: program.to_string_lossy().to_string(),
                args: args.clone(),
            },
        );
    }
}

fn powershell_set_location_command(path: &str) -> String {
    format!("Set-Location -LiteralPath '{}'", path.replace('\'', "''"))
}

fn build_open_project_commands(
    target: &str,
    path: &str,
    os: &str,
) -> Result<Vec<OpenProjectCommand>, String> {
    let commands = match target {
        "vscode" => match os {
            "windows" => {
                let mut commands = Vec::new();
                push_windows_local_program(
                    &mut commands,
                    &["Programs", "Microsoft VS Code", "Code.exe"],
                    vec![path.to_string()],
                );
                for base in ["PROGRAMFILES", "ProgramFiles(x86)"] {
                    if let Some(code_exe) = env_path(base, &["Microsoft VS Code", "Code.exe"]) {
                        push_unique_command(
                            &mut commands,
                            OpenProjectCommand {
                                program: code_exe,
                                args: vec![path.to_string()],
                            },
                        );
                    }
                }
                push_unique_command(
                    &mut commands,
                    OpenProjectCommand {
                        program: "code".to_string(),
                        args: vec![path.to_string()],
                    },
                );
                commands
            }
            "macos" => vec![OpenProjectCommand {
                program: "open".to_string(),
                args: vec![
                    "-a".to_string(),
                    "Visual Studio Code".to_string(),
                    path.to_string(),
                ],
            }],
            _ => vec![OpenProjectCommand {
                program: "code".to_string(),
                args: vec![path.to_string()],
            }],
        },
        "cursor" => match os {
            "windows" => {
                let mut commands = Vec::new();
                push_windows_local_program(
                    &mut commands,
                    &["Programs", "cursor", "Cursor.exe"],
                    vec![path.to_string()],
                );
                push_windows_local_program(
                    &mut commands,
                    &["Programs", "Cursor", "Cursor.exe"],
                    vec![path.to_string()],
                );
                for base in ["LOCALAPPDATA", "PROGRAMFILES"] {
                    if let Some(cursor_exe) = env_path(base, &["Programs", "Cursor", "Cursor.exe"])
                    {
                        push_unique_command(
                            &mut commands,
                            OpenProjectCommand {
                                program: cursor_exe,
                                args: vec![path.to_string()],
                            },
                        );
                    }
                }
                commands
            }
            "macos" => vec![OpenProjectCommand {
                program: "open".to_string(),
                args: vec!["-a".to_string(), "Cursor".to_string(), path.to_string()],
            }],
            _ => vec![OpenProjectCommand {
                program: "cursor".to_string(),
                args: vec![path.to_string()],
            }],
        },
        "file_explorer" => match os {
            "windows" => vec![OpenProjectCommand {
                program: "explorer".to_string(),
                args: vec![path.to_string()],
            }],
            "macos" => vec![OpenProjectCommand {
                program: "open".to_string(),
                args: vec![path.to_string()],
            }],
            _ => vec![OpenProjectCommand {
                program: "xdg-open".to_string(),
                args: vec![path.to_string()],
            }],
        },
        "terminal" => match os {
            "windows" => vec![
                OpenProjectCommand {
                    program: "wt".to_string(),
                    args: vec!["-d".to_string(), path.to_string()],
                },
                cmd_start_command("wt", vec!["-d".to_string(), path.to_string()]),
                cmd_start_command(
                    "powershell",
                    vec![
                        "-NoExit".to_string(),
                        "-Command".to_string(),
                        powershell_set_location_command(path),
                    ],
                ),
            ],
            "macos" => vec![OpenProjectCommand {
                program: "open".to_string(),
                args: vec!["-a".to_string(), "Terminal".to_string(), path.to_string()],
            }],
            _ => vec![OpenProjectCommand {
                program: "x-terminal-emulator".to_string(),
                args: vec!["--working-directory".to_string(), path.to_string()],
            }],
        },
        "git_bash" => match os {
            "windows" => {
                let mut commands = Vec::new();
                for base in ["PROGRAMFILES", "ProgramFiles(x86)"] {
                    if let Some(git_bash) = env_path(base, &["Git", "git-bash.exe"]) {
                        commands.push(OpenProjectCommand {
                            program: git_bash,
                            args: vec![format!("--cd={}", path)],
                        });
                    }
                }
                commands.push(OpenProjectCommand {
                    program: "C:\\Program Files\\Git\\git-bash.exe".to_string(),
                    args: vec![format!("--cd={}", path)],
                });
                commands.push(OpenProjectCommand {
                    program: "C:\\Program Files (x86)\\Git\\git-bash.exe".to_string(),
                    args: vec![format!("--cd={}", path)],
                });
                commands.push(cmd_start_command(
                    "git-bash.exe",
                    vec![format!("--cd={}", path)],
                ));
                commands
            }
            _ => vec![OpenProjectCommand {
                program: "git-bash".to_string(),
                args: vec![format!("--cd={}", path)],
            }],
        },
        _ => return Err(format!("Unsupported project open target: {}", target)),
    };

    Ok(commands)
}

fn spawn_open_project_commands(commands: Vec<OpenProjectCommand>) -> Result<(), String> {
    let mut errors = Vec::new();

    for command in commands {
        match std::process::Command::new(&command.program)
            .args(&command.args)
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) => {
                errors.push(format!("{}: {}", command.program, error));
            }
        }
    }

    Err(format!(
        "Failed to open project. Tried: {}",
        errors.join("; ")
    ))
}

/// Resolve a file path against an optional base path, with security validation.
/// Returns the canonical path if it passes the security check.
fn resolve_secure_path(
    path: &str,
    base_path: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        base.join(path)
    };

    // Security: ensure the resolved path is under the base directory
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {} (path: {})", e, full_path.display()))?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    Ok(canonical)
}

/// Resolve a file path for write/delete operations.
/// For new files, the parent directory must exist and be within the base path.
fn resolve_secure_path_for_write(
    path: &str,
    base_path: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        base.join(path)
    };

    // For write operations, check the parent directory exists and is within base
    let parent = full_path
        .parent()
        .ok_or("Invalid path: no parent directory")?;
    let canonical_parent = parent.canonicalize().map_err(|e| {
        format!(
            "Parent directory not found: {} (path: {})",
            e,
            parent.display()
        )
    })?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_parent.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    Ok(full_path)
}

/// Open a directory in the system file explorer.
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    info!(target: "file", "Opening in explorer path={}", path);
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
pub fn open_project_path(path: String, target: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    info!(target: "file", "Opening project path={} target={}", path, target);
    let commands = build_open_project_commands(&target, &path, std::env::consts::OS)?;
    spawn_open_project_commands(commands)
}

#[tauri::command]
pub fn read_file(
    _app: AppHandle,
    path: String,
    base_path: Option<String>,
) -> Result<String, String> {
    let canonical = resolve_secure_path(&path, base_path)?;
    debug!(target: "file", "Reading file path={}", canonical.display());
    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

/// Write content to a file. Creates the file if it doesn't exist.
#[tauri::command]
pub fn write_file(
    _app: AppHandle,
    path: String,
    content: String,
    base_path: Option<String>,
) -> Result<(), String> {
    let full_path = resolve_secure_path_for_write(&path, base_path)?;
    info!(target: "file", "Writing file path={} bytes={}", full_path.display(), content.len());
    // Create parent directories if they don't exist
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    std::fs::write(&full_path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Delete a file from disk.
#[tauri::command]
pub fn delete_file(_app: AppHandle, path: String, base_path: Option<String>) -> Result<(), String> {
    let canonical = resolve_secure_path(&path, base_path)?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", canonical.display()));
    }
    info!(target: "file", "Deleting file path={}", canonical.display());
    std::fs::remove_file(&canonical).map_err(|e| format!("Failed to delete file: {}", e))
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
pub fn list_directory(
    _app: AppHandle,
    path: String,
    base_path: Option<String>,
    depth: Option<u32>,
) -> Result<Vec<FileNode>, String> {
    debug!(target: "file", "Listing directory path={} depth={}", path, depth.unwrap_or(2));
    // Use provided base_path as security base, or fall back to current_dir
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("Base path not found: {}", e))?;

    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("Path not found: {}", e))?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    // Cap depth at 5 to prevent huge responses
    let max_depth = depth.unwrap_or(2).min(5);
    list_dir_recursive(&canonical, max_depth, &canonical_base)
}

fn list_dir_recursive(
    dir: &std::path::Path,
    remaining_depth: u32,
    canonical_base: &std::path::Path,
) -> Result<Vec<FileNode>, String> {
    let excluded = [
        ".git",
        "node_modules",
        "target",
        ".next",
        "dist",
        ".venv",
        "__pycache__",
        ".turbo",
        ".cache",
        "build",
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

        // Normalize path to forward slashes, stripping Windows extended-length prefix
        let path_str = path.to_string_lossy().replace('\\', "/");
        let path_str = match path_str.strip_prefix("//?/") {
            Some(s) => s.to_string(),
            None => path_str,
        };

        let children = if is_dir && remaining_depth > 0 {
            Some(list_dir_recursive(
                &path,
                remaining_depth - 1,
                canonical_base,
            )?)
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
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Read a file from the user's home directory.
/// `relative_path` is relative to ~ (e.g. ".codex/models_cache.json").
#[tauri::command]
pub fn read_home_file(relative_path: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let path = home.join(&relative_path);
    std::fs::read_to_string(&path).map_err(|e| format!("文件读取失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::{build_open_project_command, build_open_project_commands};

    #[test]
    fn builds_windows_terminal_open_project_command() {
        let command =
            build_open_project_command("terminal", "D:\\project\\app", "windows").unwrap();

        assert_eq!(command.program, "wt");
        assert_eq!(command.args, vec!["-d", "D:\\project\\app"]);
    }

    #[test]
    fn rejects_unsupported_open_project_targets() {
        let error =
            build_open_project_command("unknown", "D:\\project\\app", "windows").unwrap_err();

        assert_eq!(error, "Unsupported project open target: unknown");
    }

    #[test]
    fn builds_windows_vscode_candidates_with_exe_launchers() {
        let commands =
            build_open_project_commands("vscode", "D:\\project\\app", "windows").unwrap();

        assert!(commands
            .iter()
            .any(|command| command.program.ends_with("Code.exe")));
        assert!(commands.iter().all(|command| command.program != "cmd"));
    }

    #[test]
    fn builds_cursor_target_instead_of_visual_studio() {
        let commands =
            build_open_project_commands("cursor", "D:\\project\\app", "windows").unwrap();

        assert!(commands
            .iter()
            .any(|command| command.program.ends_with("Cursor.exe")));
        assert!(commands.iter().all(|command| command.program != "cmd"));
        assert!(
            build_open_project_commands("visual_studio", "D:\\project\\app", "windows").is_err()
        );
    }

    #[test]
    fn builds_windows_git_bash_candidates_with_known_install_path() {
        let commands =
            build_open_project_commands("git_bash", "D:\\project\\app", "windows").unwrap();

        assert!(commands
            .iter()
            .any(|command| command.program.ends_with("Git\\git-bash.exe")));
    }
}
