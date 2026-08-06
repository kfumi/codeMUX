//! Runtime 解析器：从文件系统解析当前 Provider Runtime 路径，供 sidecar 加载 SDK 使用。
//!
//! 这是 Runtime Manager 的轻量级只读视图，不涉及下载、安装或互斥锁。
//! Agent 命令在 `ensure_session` 前调用 `resolve_runtime_ref` 获取 `ProviderRuntimeRef`，
//! 通过 stdin 传给 sidecar，sidecar 据此从显式路径加载 SDK。

use std::path::PathBuf;

use serde::Serialize;

use super::seam::{FileSystemRuntimeRoots, RuntimeFileSystem};
use super::types::Provider;

/// 传递给 sidecar 的 Runtime 解析结果。镜像 sidecar `ProviderRuntimeRef`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeRef {
    pub provider: String,
    pub runtime_root: String,
    pub runtime_path: String,
    pub runtime_version: String,
    pub sidecar_compat: Option<String>,
}

/// Runtime 解析器。包装 `FileSystemRuntimeRoots`，提供只读查询能力。
pub struct RuntimeResolver {
    roots: FileSystemRuntimeRoots,
}

impl RuntimeResolver {
    /// 使用默认根目录（`%LOCALAPPDATA%\CodeMUX\runtimes`）创建解析器。
    pub fn default_root() -> Self {
        Self {
            roots: FileSystemRuntimeRoots::new(FileSystemRuntimeRoots::default_root()),
        }
    }

    /// 使用指定根目录创建解析器（主要用于测试）。
    pub fn new(root: PathBuf) -> Self {
        Self {
            roots: FileSystemRuntimeRoots::new(root),
        }
    }

    /// 返回 Runtime 根目录。
    pub fn root(&self) -> &std::path::Path {
        self.roots.root()
    }

    /// 解析指定 Provider 的当前 Runtime 引用。
    /// 返回 `None` 表示该 Provider 尚未安装。
    pub fn resolve_runtime_ref(&self, provider: Provider) -> Option<ProviderRuntimeRef> {
        let version = self.roots.read_current_version(provider)?;
        let runtime_path = self.roots.version_dir(provider, &version);

        // 验证版本目录确实存在（防止残留的 current 文件指向已删除目录）
        if !runtime_path.exists() {
            return None;
        }

        // 验证关键文件存在（package.json）
        if !runtime_path.join("package.json").exists() {
            return None;
        }

        Some(ProviderRuntimeRef {
            provider: provider.as_str().to_string(),
            runtime_root: self.roots.root().to_string_lossy().to_string(),
            runtime_path: runtime_path.to_string_lossy().to_string(),
            runtime_version: version,
            sidecar_compat: None,
        })
    }

    /// 列出指定 Provider 的所有已安装版本。
    pub fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
        self.roots.list_installed_versions(provider)
    }

    /// 检查指定 Provider 的当前版本目录是否存在且包含关键文件。
    pub fn check_integrity(&self, provider: Provider) -> bool {
        let Some(version) = self.roots.read_current_version(provider) else {
            return false;
        };
        let dir = self.roots.version_dir(provider, &version);
        if !dir.exists() {
            return false;
        }
        dir.join("package.json").exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_runtime_pack(root: &std::path::Path, provider: Provider, version: &str) {
        let dir = root.join(provider.as_str()).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), b"{}").unwrap();
        // 写入 current 指针
        std::fs::write(root.join(provider.as_str()).join("current"), version).unwrap();
    }

    #[test]
    fn resolve_returns_none_when_not_installed() {
        let tmp = TempDir::new().unwrap();
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.resolve_runtime_ref(Provider::ClaudeCode).is_none());
    }

    #[test]
    fn resolve_returns_ref_when_installed() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::ClaudeCode, "0.3.170");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());

        let ref_ = resolver.resolve_runtime_ref(Provider::ClaudeCode).unwrap();
        assert_eq!(ref_.provider, "claude_code");
        assert_eq!(ref_.runtime_version, "0.3.170");
        assert!(ref_.runtime_path.contains("0.3.170"));
    }

    #[test]
    fn resolve_returns_none_when_version_dir_missing() {
        let tmp = TempDir::new().unwrap();
        // 写入 current 指针但不创建版本目录
        std::fs::create_dir_all(tmp.path().join("claude_code")).unwrap();
        std::fs::write(tmp.path().join("claude_code").join("current"), "0.3.170").unwrap();

        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.resolve_runtime_ref(Provider::ClaudeCode).is_none());
    }

    #[test]
    fn resolve_returns_none_when_package_json_missing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("claude_code").join("0.3.170");
        std::fs::create_dir_all(&dir).unwrap();
        // 不创建 package.json
        std::fs::write(tmp.path().join("claude_code").join("current"), "0.3.170").unwrap();

        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.resolve_runtime_ref(Provider::ClaudeCode).is_none());
    }

    #[test]
    fn list_installed_versions_returns_all() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::Codex, "0.139.0");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        let versions = resolver.list_installed_versions(Provider::Codex);
        assert_eq!(versions, vec!["0.139.0"]);
    }

    #[test]
    fn check_integrity_returns_false_when_not_installed() {
        let tmp = TempDir::new().unwrap();
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(!resolver.check_integrity(Provider::OpenCode));
    }

    #[test]
    fn check_integrity_returns_true_when_pack_valid() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::OpenCode, "1.18.3");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::OpenCode));
    }
}
