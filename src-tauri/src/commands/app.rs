use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

#[tauri::command]
pub fn get_log_directory(app: AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve log directory: {}", error))?;

    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create log directory: {}", error))?;

    Ok(log_dir.to_string_lossy().to_string())
}

/// Returns the app data directory path (where config.json lives).
#[tauri::command]
pub fn get_app_data_directory(app: AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;

    Ok(data_dir.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
pub struct LogFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
}

/// List log files in the log directory.
#[tauri::command]
pub fn get_log_files(app: AppHandle) -> Result<Vec<LogFileInfo>, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve log directory: {}", error))?;

    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files: Vec<LogFileInfo> = Vec::new();
    let entries = fs::read_dir(&log_dir)
        .map_err(|error| format!("Failed to read log directory: {}", error))?;

    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let size = metadata.len();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                let datetime: chrono::DateTime<chrono::Local> = t.into();
                Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
            })
            .unwrap_or_default();

        files.push(LogFileInfo {
            name,
            path,
            size,
            modified,
        });
    }

    // Sort by modified time, newest first
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(files)
}

/// Read the content of a log file by name (resolved safely within the log directory).
#[tauri::command]
pub fn read_log_file(app: AppHandle, file_name: String) -> Result<String, String> {
    // Security: reject names with path separators to prevent directory traversal
    if file_name.contains('/') || file_name.contains('\\') {
        return Err(format!(
            "Invalid file name: must not contain path separators (got: {})",
            file_name
        ));
    }

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve log directory: {}", error))?;

    // Ensure log directory exists (same as get_log_directory)
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create log directory: {}", error))?;

    let target = log_dir.join(&file_name);
    fs::read_to_string(&target)
        .map_err(|error| format!("Failed to read log file {}: {}", target.display(), error))
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentCheckStatus {
    Ok,
    Warning,
    Missing,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeVersionStatus {
    Ok,
    Warning,
    Invalid,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentToolCheck {
    pub name: String,
    pub command: String,
    pub status: EnvironmentCheckStatus,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentEnvironmentCheck {
    pub checked_at: String,
    pub tools: Vec<EnvironmentToolCheck>,
}

#[tauri::command]
pub fn check_development_environment() -> DevelopmentEnvironmentCheck {
    let checked_at = chrono::Local::now().to_rfc3339();
    DevelopmentEnvironmentCheck {
        checked_at,
        tools: vec![check_node(), check_git()],
    }
}

fn check_node() -> EnvironmentToolCheck {
    match run_version_command("node", "--version") {
        Ok(output) => match classify_node_version(&output) {
            NodeVersionStatus::Ok => EnvironmentToolCheck {
                name: "Node.js".into(),
                command: "node".into(),
                status: EnvironmentCheckStatus::Ok,
                version: parse_node_version(&output),
                path: find_command_path("node"),
                message: "Node.js 可用。".into(),
            },
            NodeVersionStatus::Warning => EnvironmentToolCheck {
                name: "Node.js".into(),
                command: "node".into(),
                status: EnvironmentCheckStatus::Warning,
                version: parse_node_version(&output),
                path: find_command_path("node"),
                message: "Node.js 版本低于 18.0.0，请升级到 Node.js 18+。".into(),
            },
            NodeVersionStatus::Invalid => EnvironmentToolCheck {
                name: "Node.js".into(),
                command: "node".into(),
                status: EnvironmentCheckStatus::Error,
                version: None,
                path: find_command_path("node"),
                message: format!("无法解析 Node.js 版本输出：{}", output.trim()),
            },
        },
        Err(EnvironmentCommandError::Missing) => EnvironmentToolCheck {
            name: "Node.js".into(),
            command: "node".into(),
            status: EnvironmentCheckStatus::Missing,
            version: None,
            path: None,
            message: "未找到 Node.js，请安装 Node.js 18+ 并确认 PATH 已生效。".into(),
        },
        Err(EnvironmentCommandError::Failed(message)) => EnvironmentToolCheck {
            name: "Node.js".into(),
            command: "node".into(),
            status: EnvironmentCheckStatus::Error,
            version: None,
            path: find_command_path("node"),
            message,
        },
    }
}

fn check_git() -> EnvironmentToolCheck {
    match run_version_command("git", "--version") {
        Ok(output) => match parse_git_version(&output) {
            Some(version) => EnvironmentToolCheck {
                name: "Git".into(),
                command: "git".into(),
                status: EnvironmentCheckStatus::Ok,
                version: Some(version),
                path: find_command_path("git"),
                message: "Git 可用。".into(),
            },
            None => EnvironmentToolCheck {
                name: "Git".into(),
                command: "git".into(),
                status: EnvironmentCheckStatus::Error,
                version: None,
                path: find_command_path("git"),
                message: format!("无法解析 Git 版本输出：{}", output.trim()),
            },
        },
        Err(EnvironmentCommandError::Missing) => EnvironmentToolCheck {
            name: "Git".into(),
            command: "git".into(),
            status: EnvironmentCheckStatus::Missing,
            version: None,
            path: None,
            message: "未找到 Git，请安装 Git 并确认 PATH 已生效。".into(),
        },
        Err(EnvironmentCommandError::Failed(message)) => EnvironmentToolCheck {
            name: "Git".into(),
            command: "git".into(),
            status: EnvironmentCheckStatus::Error,
            version: None,
            path: find_command_path("git"),
            message,
        },
    }
}

enum EnvironmentCommandError {
    Missing,
    Failed(String),
}

fn configure_command(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command
}

fn run_version_command(command: &str, arg: &str) -> Result<String, EnvironmentCommandError> {
    let mut process = Command::new(command);
    configure_command(process.arg(arg));

    let output = process.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            EnvironmentCommandError::Missing
        } else {
            EnvironmentCommandError::Failed(format!("执行 {} {} 失败：{}", command, arg, error))
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("退出码 {:?}", output.status.code())
        } else {
            stderr
        };
        return Err(EnvironmentCommandError::Failed(format!(
            "{} {} 执行失败：{}",
            command, arg, detail
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn classify_node_version(output: &str) -> NodeVersionStatus {
    let Some(version) = parse_node_version(output) else {
        return NodeVersionStatus::Invalid;
    };
    let major = version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok());

    match major {
        Some(value) if value >= 18 => NodeVersionStatus::Ok,
        Some(_) => NodeVersionStatus::Warning,
        None => NodeVersionStatus::Invalid,
    }
}

fn parse_node_version(output: &str) -> Option<String> {
    let trimmed = output.trim();
    let version = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if version
        .split('.')
        .take(3)
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
    {
        Some(version.to_string())
    } else {
        None
    }
}

pub fn parse_git_version(output: &str) -> Option<String> {
    output
        .trim()
        .strip_prefix("git version ")
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

fn find_command_path(command: &str) -> Option<String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("where");
        cmd.arg(if command == "node" {
            "node.exe"
        } else {
            command
        });
        cmd
    } else {
        let mut cmd = Command::new("which");
        cmd.arg(command);
        cmd
    };
    configure_command(&mut cmd);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{classify_node_version, parse_git_version, NodeVersionStatus};

    #[test]
    fn classifies_supported_node_versions_as_ok() {
        assert_eq!(classify_node_version("v18.0.0"), NodeVersionStatus::Ok);
        assert_eq!(classify_node_version("v22.17.0"), NodeVersionStatus::Ok);
    }

    #[test]
    fn classifies_old_node_versions_as_warning() {
        assert_eq!(
            classify_node_version("v16.20.0"),
            NodeVersionStatus::Warning
        );
    }

    #[test]
    fn parses_git_version_from_command_output() {
        assert_eq!(
            parse_git_version("git version 2.34.1.windows.1"),
            Some("2.34.1.windows.1".to_string())
        );
    }
}
