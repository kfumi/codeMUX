//! 进程级 Node 工具链解析。
//!
//! 发布包随带一份独立 Node.js 运行时(electron-builder 落到资源根的 `node/`),
//! sidecar 启动、托管 Runtime 的 npm 安装与设置页检测都优先用它,从而不依赖用户
//! 机器上 PATH 里的 Node.js —— 客户机器只有旧版(如 Node 14)或完全没有 Node 时
//! 也能运行。
//!
//! 未随包时(本地开发未暂存运行时)回落到 PATH 中的 `node`/`npm`,保持既有行为。
//! 运行时目录布局与官方发行包解压后一致:
//! - Windows:`<dir>/node.exe`、`<dir>/npm.cmd`
//! - unix:`<dir>/bin/node`、`<dir>/bin/npm`

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 随包运行时在资源根下的目录名(与 electron-builder.yml 的 `to: node` 一致)。
const BUNDLED_NODE_DIR_NAME: &str = "node";
/// 开发态源码树里的暂存目录(与 `extraResources` 的 `from` 一致)。
const DEV_STAGING_RELATIVE: &[&str] = &["apps", "desktop", "node-runtime"];

/// 进程启动时解析出的随包 Node 目录。`None` 表示未随包 → 回落 PATH。
static BUNDLED_NODE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 平台 node 可执行文件名(PATH 回落时直接用裸名)。
pub fn node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// 平台 npm 命令名(PATH 回落时直接用裸名)。
pub fn npm_command_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// 随包运行时目录内的 node 二进制。
pub fn node_binary_in(dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        dir.join("node.exe")
    } else {
        dir.join("bin").join("node")
    }
}

/// 随包运行时目录内的 npm 命令。
pub fn npm_command_in(dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        dir.join("npm.cmd")
    } else {
        dir.join("bin").join("npm")
    }
}

/// 解析随包 Node 目录:资源根优先,debug 构建(非测试)回落源码树暂存目录。
///
/// 测试构建刻意关闭 dev 回落,保证断言与开发者本机是否暂存过运行时无关。
pub fn resolve_bundled_node_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(resource_dir) = resource_dir {
        let candidate = resource_dir.join(BUNDLED_NODE_DIR_NAME);
        if node_binary_in(&candidate).is_file() {
            return Some(candidate);
        }
    }
    if dev_fallback_enabled() {
        let mut dev = crate::paths::repo_root_from_or_two_up(Path::new(env!("CARGO_MANIFEST_DIR")));
        for part in DEV_STAGING_RELATIVE {
            dev.push(part);
        }
        if node_binary_in(&dev).is_file() {
            return Some(dev);
        }
    }
    None
}

fn dev_fallback_enabled() -> bool {
    cfg!(debug_assertions) && !cfg!(test)
}

/// 记录进程级 Node 工具链(daemon 组装时调用一次)。
pub fn init(resource_dir: Option<&Path>) {
    let _ = BUNDLED_NODE_DIR.set(resolve_bundled_node_dir(resource_dir));
}

/// 已解析的随包 Node 目录;`None` 表示继续用 PATH。
pub fn bundled_node_dir_resolved() -> Option<PathBuf> {
    BUNDLED_NODE_DIR.get().cloned().flatten()
}

/// sidecar 应使用的 node 二进制:随包优先,否则 PATH 裸名。
///
/// 直接按传入的 `resource_dir` 解析,不依赖 [`init`] —— sidecar 启动路径已有
/// 资源根,显式传参比读全局状态更确定。
pub fn resolve_node_binary(resource_dir: Option<&Path>) -> PathBuf {
    match resolve_bundled_node_dir(resource_dir) {
        Some(dir) => node_binary_in(&dir),
        None => PathBuf::from(node_binary_name()),
    }
}

/// npm 命令:随包优先,否则 PATH 裸名。依赖 [`init`] 已记录随包目录。
pub fn npm_command() -> PathBuf {
    match bundled_node_dir_resolved() {
        Some(dir) => npm_command_in(&dir),
        None => PathBuf::from(npm_command_name()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        node_binary_in, node_binary_name, npm_command_in, resolve_bundled_node_dir,
        resolve_node_binary,
    };
    use std::fs;

    #[test]
    fn resource_root_node_dir_is_preferred_when_binary_present() {
        let temp = tempfile::tempdir().expect("tempdir");
        let node_dir = temp.path().join("node");
        fs::create_dir_all(&node_dir).expect("mkdir");
        let binary = node_binary_in(&node_dir);
        fs::write(&binary, b"stub").expect("write stub");

        assert_eq!(
            resolve_bundled_node_dir(Some(temp.path())),
            Some(node_dir),
            "资源根下的 node/ 应被识别为随包运行时"
        );
    }

    #[test]
    fn resource_root_missing_binary_is_not_treated_as_bundled() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("node")).expect("mkdir");

        assert_eq!(
            resolve_bundled_node_dir(Some(temp.path())),
            None,
            "目录存在但没有 node 二进制时不算随包运行时"
        );
    }

    #[test]
    fn resolve_node_binary_falls_back_to_path_command() {
        let temp = tempfile::tempdir().expect("tempdir");

        assert_eq!(
            resolve_node_binary(Some(temp.path())),
            std::path::PathBuf::from(node_binary_name()),
            "没有随包运行时时回落到 PATH 中的裸 node 名"
        );
    }

    #[test]
    fn npm_command_lives_beside_node_binary_in_the_same_dir() {
        let dir = std::path::Path::new("C:/codemux/node");
        let node = node_binary_in(dir);
        let npm = npm_command_in(dir);

        assert_eq!(node.parent(), npm.parent(), "node 与 npm 必须同目录(同源)");
    }
}
