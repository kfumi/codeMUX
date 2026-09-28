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
    #[serde(skip_serializing_if = "Option::is_none")]
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

    /// 检查指定 Provider 的当前版本目录是否存在且包含关键文件与关键二进制。
    ///
    /// 这是纯本地检测，不依赖网络拉取 manifest。关键二进制路径基于 Provider
    /// 和当前平台推断，与 npm Runtime 的关键平台依赖保持一致。
    pub fn check_integrity(&self, provider: Provider) -> bool {
        let Some(version) = self.roots.read_current_version(provider) else {
            return false;
        };
        let dir = self.roots.version_dir(provider, &version);
        if !dir.exists() {
            return false;
        }
        if !dir.join("package.json").exists() {
            return false;
        }
        // 校验关键二进制存在（spec L17/L63：检查关键二进制以提前发现不完整安装）。
        // npm 在 Windows 上可能只生成 opencode.exe，.cmd 是可选的命令行 shim，
        // 两者不应同时作为 Runtime 完整性的硬性前置条件。
        if provider == Provider::OpenCode && cfg!(target_os = "windows") {
            let has_open_code_binary = self
                .local_key_binaries(provider)
                .iter()
                .any(|binary_rel| dir.join(binary_rel).exists());
            return has_open_code_binary;
        }
        for binary_rel in self.local_key_binaries(provider) {
            let binary_path = dir.join(&binary_rel);
            if !binary_path.exists() {
                return false;
            }
        }
        true
    }

    /// 返回指定 Provider 在当前平台下的关键二进制相对路径（本地推断，不依赖 manifest）。
    ///
    /// 与 npm Runtime 安装器的关键文件约定保持一致：
    /// - ClaudeCode: `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude[.exe]`
    /// - Codex: 无平台二进制（纯 SDK）
    /// - OpenCode: `opencode-ai/bin/opencode[.exe|.cmd]`
    /// - Pi: `@earendil-works/pi-coding-agent/dist/bundle/cli.js`（纯 Node 包，无平台二进制）
    fn local_key_binaries(&self, provider: Provider) -> Vec<String> {
        match provider {
            Provider::ClaudeCode => {
                let (platform_name, arch_suffix, binary_name) = if cfg!(target_os = "windows") {
                    ("win32", "x64", "claude.exe")
                } else if cfg!(target_os = "macos") {
                    ("darwin", "x64", "claude")
                } else {
                    ("linux", "x64", "claude")
                };
                vec![format!(
                    "node_modules/@anthropic-ai/claude-agent-sdk-{}-{}/{}",
                    platform_name, arch_suffix, binary_name
                )]
            }
            Provider::Codex => Vec::new(),
            Provider::OpenCode => {
                if cfg!(target_os = "windows") {
                    vec![
                        "node_modules/opencode-ai/bin/opencode.exe".to_string(),
                        "node_modules/opencode-ai/bin/opencode.cmd".to_string(),
                    ]
                } else {
                    vec!["node_modules/opencode-ai/bin/opencode".to_string()]
                }
            }
            Provider::Pi => {
                vec!["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js".to_string()]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::NpmRuntimeSpec;
    use tempfile::TempDir;

    fn create_runtime_pack(root: &std::path::Path, provider: Provider, version: &str) {
        let dir = root.join(provider.as_str()).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), b"{}").unwrap();
        // 写入 current 指针
        std::fs::write(root.join(provider.as_str()).join("current"), version).unwrap();
    }

    /// 创建包含关键二进制的完整 npm Runtime（用于完整性校验测试）。
    fn create_full_runtime_pack(root: &std::path::Path, provider: Provider, version: &str) {
        create_runtime_pack(root, provider, version);
        let dir = root.join(provider.as_str()).join(version);
        let resolver = RuntimeResolver::new(root.to_path_buf());
        for binary_rel in resolver.local_key_binaries(provider) {
            let binary_path = dir.join(&binary_rel);
            if let Some(parent) = binary_path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&binary_path, b"fake-binary").unwrap();
        }
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
        // Codex 无关键二进制，仅校验 package.json
        create_runtime_pack(tmp.path(), Provider::Codex, "0.139.0");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::Codex));
    }

    #[test]
    fn check_integrity_returns_true_when_key_binaries_present() {
        let tmp = TempDir::new().unwrap();
        create_full_runtime_pack(tmp.path(), Provider::ClaudeCode, "0.3.170");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::ClaudeCode));
    }

    #[test]
    fn check_integrity_returns_false_when_key_binary_missing() {
        let tmp = TempDir::new().unwrap();
        // 仅创建 package.json，不创建关键二进制
        create_runtime_pack(tmp.path(), Provider::ClaudeCode, "0.3.170");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(!resolver.check_integrity(Provider::ClaudeCode));
    }

    #[test]
    fn check_integrity_returns_false_when_opencode_binary_missing() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::OpenCode, "1.18.3");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(!resolver.check_integrity(Provider::OpenCode));
    }

    #[test]
    fn check_integrity_returns_true_for_opencode_with_binaries() {
        let tmp = TempDir::new().unwrap();
        create_full_runtime_pack(tmp.path(), Provider::OpenCode, "1.18.3");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::OpenCode));
    }

    /// pi 是纯 Node 包：完整性凭证就是 bun bundle 的 `dist/bundle/cli.js`。包名或入口
    /// 路径一旦漂移，已装好的 Runtime 会被判为损坏（`check_integrity` 返回 false），
    /// 这正是我们想要的失败方式——迁移与禁止回退的理由见
    /// `docs/research/2026-09-28-pi-npm-package-migration.md`。
    #[test]
    fn check_integrity_returns_false_when_pi_bundle_entry_missing() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::Pi, "0.87.1");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(!resolver.check_integrity(Provider::Pi));
    }

    #[test]
    fn check_integrity_returns_true_for_pi_with_bundle_entry() {
        let tmp = TempDir::new().unwrap();
        create_full_runtime_pack(tmp.path(), Provider::Pi, "0.87.1");
        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::Pi));
    }

    /// 钉住 pi 托管 Runtime 的目录契约（包名 + 入口相对路径，与 spawn 侧
    /// `apps/sidecar/src/piRuntime.ts` 的 `PI_RPC_ENTRY_RELATIVE` 必须一致）。改这个断言
    /// 等于宣布不再兼容已安装的 Runtime 布局，必须同时更新迁移调研与设置页安装文案。
    #[test]
    fn pi_runtime_pack_contract_pins_package_and_entry_path() {
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "0.87.1").unwrap();
        assert_eq!(
            spec.packages,
            vec!["@earendil-works/pi-coding-agent@0.87.1"]
        );
        let resolver = RuntimeResolver::new(std::path::PathBuf::new());
        assert_eq!(
            resolver.local_key_binaries(Provider::Pi),
            vec!["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn check_integrity_accepts_opencode_exe_without_cmd_shim() {
        let tmp = TempDir::new().unwrap();
        create_runtime_pack(tmp.path(), Provider::OpenCode, "1.18.14");
        let binary = tmp
            .path()
            .join("opencode")
            .join("1.18.14")
            .join("node_modules/opencode-ai/bin/opencode.exe");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(binary, b"fake-binary").unwrap();

        let resolver = RuntimeResolver::new(tmp.path().to_path_buf());
        assert!(resolver.check_integrity(Provider::OpenCode));
    }
}
