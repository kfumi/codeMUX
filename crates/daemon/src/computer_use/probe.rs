//! 驱动零配置探测(工单 08):`driver_command` 留空时按官方安装位置与 PATH
//! 自动找 cua-driver,启动参数默认 `mcp` 子命令 —— 目标是「不填也能启动」。
//!
//! 探测只做文件存在性检查(几次 stat,无子进程):真正的可用性验证交给启动
//! 时的 MCP 握手。默认参数与安装落点以 `cua-driver manifest` 自报的
//! `mcp_invocation`(0.34.0 实测:`{"args":["mcp"], ...}`)为准,不靠猜。

use std::path::{Path, PathBuf};

/// `driver_command` 与 `driver_args` 都留空时的默认启动参数。
pub const DEFAULT_DRIVER_ARGS: &[&str] = &["mcp"];

/// 官方安装脚本地址(一键安装与界面提示共用同一份事实)。
pub const INSTALL_SCRIPT_URL: &str = "https://cua.ai/driver/install.ps1";

/// 驱动可执行文件名(按平台)。
pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "cua-driver.exe"
    } else {
        "cua-driver"
    }
}

/// 默认候选路径(纯函数):`local_app_data` 与 `home` 由调用方注入,便于测试。
///
/// 顺序即优先级:官方安装器的落点最先,`~/.local`、`~/.cua` 次之,最后是
/// Homebrew 等包管理器的惯例位置。PATH 的查找在候选全部落空后进行
/// ([`find_in_path_env`])。
pub fn candidate_paths(local_app_data: &Path, home: &Path) -> Vec<PathBuf> {
    let binary = binary_name();
    vec![
        // 官方安装脚本的实际落点(实测:%LOCALAPPDATA%\Programs\Cua\cua-driver\bin)。
        local_app_data
            .join("Programs")
            .join("Cua")
            .join("cua-driver")
            .join("bin")
            .join(binary),
        local_app_data
            .join("Programs")
            .join("Cua")
            .join("cua-driver")
            .join(binary),
        local_app_data
            .join("Programs")
            .join("cua-driver")
            .join(binary),
        home.join(".local").join("bin").join(binary),
        home.join(".cua").join("bin").join(binary),
        PathBuf::from("/usr/local/bin").join(binary),
        PathBuf::from("/opt/homebrew/bin").join(binary),
    ]
}

/// 在 PATH 环境变量的值里找二进制(接近纯函数:仅做存在性 stat)。
pub fn find_in_path_env(path_value: &str, binary: &str) -> Option<String> {
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    path_value
        .split(delimiter)
        .map(|dir| dir.trim().trim_matches('"'))
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .find_map(|dir| {
            let full = dir.join(binary);
            full.is_file().then(|| full.to_string_lossy().into_owned())
        })
}

/// 默认探测:候选路径 → PATH。找不到返回 `None`(交给「一键安装」)。
pub fn detect_default() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let binary = binary_name();
    if let Some(home) = home.as_ref() {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        if let Some(found) = candidate_paths(&local_app_data, home)
            .into_iter()
            .find_map(|path| path.is_file().then(|| path.to_string_lossy().into_owned()))
        {
            return Some(found);
        }
    }
    std::env::var("PATH")
        .ok()
        .and_then(|paths| find_in_path_env(&paths, binary))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("建目录");
        let path = dir.join(name);
        std::fs::write(&path, b"stub").expect("写占位文件");
        path
    }

    #[test]
    fn candidates_start_with_the_official_install_location() {
        let local = Path::new("L:");
        let home = Path::new("H:");
        let candidates = candidate_paths(local, home);
        let expected = local
            .join("Programs")
            .join("Cua")
            .join("cua-driver")
            .join("bin")
            .join(binary_name());
        assert_eq!(candidates.first(), Some(&expected), "官方落点必须排第一");
        assert!(candidates
            .iter()
            .any(|path| path == &home.join(".cua").join("bin").join(binary_name())));
    }

    #[test]
    fn path_lookup_finds_an_existing_binary() {
        let base = std::env::temp_dir().join(format!("cu-probe-find-{}", std::process::id()));
        let dir = base.join("bin");
        let fixture = write_fixture(&dir, "codemux-probe-fixture");
        let found = find_in_path_env(
            &format!("elsewhere{}{}", path_delimiter(), dir.to_string_lossy()),
            "codemux-probe-fixture",
        );
        assert_eq!(found.as_deref(), Some(fixture.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn path_lookup_returns_none_when_nothing_exists() {
        assert_eq!(find_in_path_env("", binary_name()), None);
        assert_eq!(find_in_path_env("  ;; ", binary_name()), None);
        assert_eq!(
            find_in_path_env(&std::env::temp_dir().to_string_lossy(), "不存在的东西"),
            None
        );
    }

    #[test]
    fn default_args_are_the_driver_mcp_subcommand() {
        assert_eq!(
            DEFAULT_DRIVER_ARGS,
            &["mcp"],
            "与 manifest 的 mcp_invocation 一致"
        );
    }

    fn path_delimiter() -> char {
        if cfg!(windows) {
            ';'
        } else {
            ':'
        }
    }
}
