//! Runtime 生产基础设施。
//!
//! Runtime SDK 由本机 Node.js/npm 安装到 CodeMUX 的托管目录；本模块只负责检测
//! 安装前置条件，不再包含 GitHub Release、归档下载或签名校验实现。

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use async_trait::async_trait;

use super::seam::NodeResolver;
use super::types::{NodeDetection, NpmDetection};

/// 通过 PATH 检测本机 Node.js。
pub struct SystemNodeResolver;

impl SystemNodeResolver {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemNodeResolver {
    fn default() -> Self {
        Self::new()
    }
}

/// 使用 CodeMUX 统一的系统 Node.js 解析逻辑。
///
/// 设置页、Runtime 安装器和 sidecar 启动路径都应基于同一套 PATH 解析结果，
/// 避免检测到的 Node.js 与实际执行的 Node.js 不一致。
pub fn detect_system_node() -> NodeDetection {
    let node_path = match find_node_in_path() {
        Some(path) => path,
        None => return NodeDetection::unavailable("PATH 中未找到 node 可执行文件"),
    };

    match query_node_version(&node_path) {
        Ok(version) => {
            NodeDetection::from_version(version, node_path.to_str().map(ToOwned::to_owned))
        }
        Err(message) => NodeDetection::unavailable(format!(
            "无法解析 node 版本（{}）：{}",
            node_path.display(),
            message
        )),
    }
}

/// 检测与指定 Node.js 解析结果对应的系统 npm。
pub fn detect_system_npm(node: &NodeDetection) -> NpmDetection {
    let command = npm_command_name();
    let executable_path = find_command_in_path(command);
    let mut npm = Command::new(command);
    configure_hidden_command(npm.arg("--version"));
    let output = match npm.output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return NpmDetection::unavailable(
                "未找到 npm，请确认 Node.js 安装包含 npm 且 PATH 已生效。",
                executable_path,
            )
        }
        Err(error) => {
            return NpmDetection::unavailable(
                format!("执行 npm --version 失败：{}", error),
                executable_path,
            )
        }
    };
    if !output.status.success() {
        return NpmDetection::unavailable(
            format!("npm --version 执行失败：退出码 {:?}", output.status.code()),
            executable_path,
        );
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return NpmDetection::unavailable("npm 版本输出为空。", executable_path);
    }

    let matches_node = node
        .executable_path
        .as_deref()
        .zip(executable_path.as_deref())
        .map(|(node_path, npm_path)| same_parent_directory(node_path, npm_path))
        .unwrap_or(false);
    NpmDetection {
        available: true,
        version: Some(version),
        executable_path,
        matches_node,
        error: if matches_node {
            None
        } else {
            Some("npm 与当前 Node.js 不在同一安装目录，请检查 PATH。".to_string())
        },
    }
}

#[async_trait]
impl NodeResolver for SystemNodeResolver {
    async fn detect(&self) -> NodeDetection {
        detect_system_node()
    }
}

/// 在 PATH 中查找 `node` 可执行文件路径。
fn find_node_in_path() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    find_command_in_path(executable).map(PathBuf::from)
}

fn find_command_in_path(command: &str) -> Option<String> {
    let which_command = if cfg!(windows) { "where" } else { "which" };
    let mut which = Command::new(which_command);
    configure_hidden_command(which.arg(command));
    let output = which.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let first_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!first_line.is_empty()).then_some(first_line)
}

fn npm_command_name() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn configure_hidden_command(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command
}

fn same_parent_directory(left: &str, right: &str) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left.parent() == right.parent()
}

/// 执行 `node --version` 并返回版本字符串。
fn query_node_version(node_path: &Path) -> Result<Option<String>, String> {
    let mut node = Command::new(node_path);
    configure_hidden_command(node.arg("--version"));
    let output = node
        .output()
        .map_err(|error| format!("执行失败：{}", error))?;
    if !output.status.success() {
        return Err(format!(
            "退出码非零：{}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!version.is_empty()).then_some(version))
}
