//! Runtime 领域的可测试边界（seam）。
//!
//! 这些 trait 为 npm Runtime Manager、检测逻辑和测试夹具提供可替换的 Node、进度和
//! 文件系统边界。

use std::path::PathBuf;

use async_trait::async_trait;

use super::error::RuntimeError;
use super::types::{InstallStage, NodeDetection, Progress, Provider};

/// 进度汇报回调。Runtime Manager 在 npm 查询、安装和校验阶段调用。
#[async_trait]
pub trait ProgressReporter: Send + Sync {
    async fn report(&self, progress: Progress);
}

/// 系统 Node.js 解析器。生产实现从 PATH 查找 node 并解析版本；测试夹具返回固定结果。
#[async_trait]
pub trait NodeResolver: Send + Sync {
    /// 检测系统 Node.js，返回版本与可执行路径。
    async fn detect(&self) -> NodeDetection;
}

/// 空进度汇报器，用于不关心进度的内部流程。
pub struct NoopProgressReporter;

#[async_trait]
impl ProgressReporter for NoopProgressReporter {
    async fn report(&self, _progress: Progress) {}
}

/// Runtime 文件系统视图。抽象 Runtime 根目录、Provider 目录、版本目录和当前版本指针，
/// 使测试夹具可以使用临时目录而非真实用户目录。
pub trait RuntimeFileSystem: Send + Sync {
    /// Runtime 根目录（生产实现为 `%LOCALAPPDATA%\CodeMUX\runtimes`）。
    fn root(&self) -> PathBuf;

    /// 指定 Provider 的目录（例如 `<root>/claude_code`）。
    fn provider_dir(&self, provider: Provider) -> PathBuf {
        self.root().join(provider.as_str())
    }

    /// 指定 Provider、版本的目录（例如 `<root>/claude_code/0.3.169`）。
    fn version_dir(&self, provider: Provider, version: &str) -> PathBuf {
        self.provider_dir(provider).join(version)
    }

    /// 指定 Provider 的当前版本指针文件路径。
    fn current_version_file(&self, provider: Provider) -> PathBuf {
        self.provider_dir(provider).join("current")
    }

    /// 读取当前版本指针。返回 `None` 表示尚未安装。
    fn read_current_version(&self, provider: Provider) -> Option<String>;

    /// 写入当前版本指针。
    fn write_current_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError>;

    /// 列出已安装的版本目录（不含 `current` 指针文件）。
    fn list_installed_versions(&self, provider: Provider) -> Vec<String>;

    /// 删除指定版本目录。若该版本是当前版本，调用方应先切换。
    fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError>;

    /// 删除指定 Provider 的所有版本和当前版本指针。
    fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError>;
}

/// 当前版本指针的读写抽象，便于在不持有完整 `RuntimeFileSystem` 时操作指针。
pub trait CurrentVersionStore: Send + Sync {
    fn read(&self, provider: Provider) -> Option<String>;
    fn write(&self, provider: Provider, version: &str) -> Result<(), RuntimeError>;
    fn clear(&self, provider: Provider) -> Result<(), RuntimeError>;
}

/// 基于真实文件系统的 Runtime 根目录解析。
///
/// 生产实现使用用户级目录；测试通过 `RuntimeFileSystem` 的夹具实现注入临时目录。
/// 本结构仅提供路径解析，不直接执行 IO。
pub struct FileSystemRuntimeRoots {
    root: PathBuf,
}

impl FileSystemRuntimeRoots {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// 生产环境的 Runtime 根目录：`%LOCALAPPDATA%\CodeMUX\runtimes`。
    /// 在非 Windows 平台回退到 `~/.local/share/CodeMUX/runtimes`。
    pub fn default_root() -> PathBuf {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local_app_data)
                .join("CodeMUX")
                .join("runtimes");
        }
        if let Some(home) = dirs::home_dir() {
            return home
                .join(".local")
                .join("share")
                .join("CodeMUX")
                .join("runtimes");
        }
        PathBuf::from("CodeMUX").join("runtimes")
    }

    pub fn root(&self) -> &std::path::Path {
        &self.root
    }
}

impl RuntimeFileSystem for FileSystemRuntimeRoots {
    fn root(&self) -> PathBuf {
        self.root.clone()
    }

    fn read_current_version(&self, provider: Provider) -> Option<String> {
        let path = self.current_version_file(provider);
        std::fs::read_to_string(&path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn write_current_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        let path = self.current_version_file(provider);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                RuntimeError::io_failed(
                    Some(provider),
                    format!("无法创建 Provider 目录 {}: {}", parent.display(), e),
                )
            })?;
        }
        let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temp_path, version).map_err(|e| {
            RuntimeError::io_failed(
                Some(provider),
                format!(
                    "无法写入当前版本指针临时文件 {}: {}",
                    temp_path.display(),
                    e
                ),
            )
        })?;
        replace_file_atomically(&temp_path, &path).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            RuntimeError::io_failed(
                Some(provider),
                format!("无法原子切换当前版本指针 {}: {}", path.display(), e),
            )
        })
    }

    fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
        let dir = self.provider_dir(provider);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut versions = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name == "current" {
                    continue;
                }
                versions.push(name.to_string());
            }
        }
        versions
    }

    fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        let dir = self.version_dir(provider, version);
        if !dir.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&dir).map_err(|e| {
            RuntimeError::io_failed(
                Some(provider),
                format!("无法删除版本目录 {}: {}", dir.display(), e),
            )
        })
    }

    fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError> {
        let dir = self.provider_dir(provider);
        if !dir.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&dir).map_err(|e| {
            RuntimeError::io_failed(
                Some(provider),
                format!("无法删除 Provider 目录 {}: {}", dir.display(), e),
            )
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomically(
    source: &std::path::Path,
    target: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(target_os = "windows")]
fn replace_file_atomically(
    source: &std::path::Path,
    target: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 进度汇报器的简单实现，将进度写入 `tokio::sync::mpsc::Sender`，供测试断言。
#[cfg(test)]
pub mod test_progress {
    use super::*;
    use tokio::sync::mpsc;

    pub struct ChannelProgressReporter {
        tx: mpsc::UnboundedSender<Progress>,
    }

    impl ChannelProgressReporter {
        pub fn new() -> (Self, mpsc::UnboundedReceiver<Progress>) {
            let (tx, rx) = mpsc::unbounded_channel();
            (Self { tx }, rx)
        }
    }

    #[async_trait]
    impl ProgressReporter for ChannelProgressReporter {
        async fn report(&self, progress: Progress) {
            let _ = self.tx.send(progress);
        }
    }

    /// 记录所有阶段到 Vec 的同步进度收集器（测试用）。
    pub struct CollectingProgressReporter {
        pub stages: std::sync::Mutex<Vec<InstallStage>>,
    }

    impl CollectingProgressReporter {
        pub fn new() -> Self {
            Self {
                stages: std::sync::Mutex::new(Vec::new()),
            }
        }

        pub fn snapshot(&self) -> Vec<InstallStage> {
            self.stages.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ProgressReporter for CollectingProgressReporter {
        async fn report(&self, progress: Progress) {
            self.stages.lock().unwrap().push(progress.stage);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fs() -> (TempDir, FileSystemRuntimeRoots) {
        let tmp = TempDir::new().unwrap();
        let roots = FileSystemRuntimeRoots::new(tmp.path().to_path_buf());
        (tmp, roots)
    }

    #[test]
    fn version_dir_layout_matches_spec() {
        let (_tmp, roots) = fs();
        let dir = roots.version_dir(Provider::ClaudeCode, "0.3.169");
        // <root>/claude_code/0.3.169
        assert!(dir.ends_with("0.3.169"));
        assert!(dir
            .parent()
            .map(|p| p.ends_with("claude_code"))
            .unwrap_or(false));
        let current = roots.current_version_file(Provider::Codex);
        // <root>/codex/current
        assert!(current.ends_with("current"));
        assert!(current
            .parent()
            .map(|p| p.ends_with("codex"))
            .unwrap_or(false));
    }

    #[test]
    fn write_and_read_current_version() {
        let (_tmp, roots) = fs();
        assert!(roots.read_current_version(Provider::OpenCode).is_none());
        roots
            .write_current_version(Provider::OpenCode, "1.18.3")
            .unwrap();
        assert_eq!(
            roots.read_current_version(Provider::OpenCode),
            Some("1.18.3".to_string())
        );
    }

    #[test]
    fn list_installed_versions_skips_current_file() {
        let (_tmp, roots) = fs();
        // 创建版本目录
        std::fs::create_dir_all(roots.version_dir(Provider::ClaudeCode, "0.3.169")).unwrap();
        std::fs::create_dir_all(roots.version_dir(Provider::ClaudeCode, "0.3.170")).unwrap();
        roots
            .write_current_version(Provider::ClaudeCode, "0.3.170")
            .unwrap();
        let mut versions = roots.list_installed_versions(Provider::ClaudeCode);
        versions.sort();
        assert_eq!(versions, vec!["0.3.169".to_string(), "0.3.170".to_string()]);
    }

    #[test]
    fn remove_version_deletes_directory() {
        let (_tmp, roots) = fs();
        std::fs::create_dir_all(roots.version_dir(Provider::Codex, "0.139.0")).unwrap();
        roots.remove_version(Provider::Codex, "0.139.0").unwrap();
        assert!(!roots.version_dir(Provider::Codex, "0.139.0").exists());
    }

    #[test]
    fn remove_version_is_idempotent() {
        let (_tmp, roots) = fs();
        roots.remove_version(Provider::Codex, "missing").unwrap();
    }

    #[test]
    fn remove_provider_clears_versions_and_pointer() {
        let (_tmp, roots) = fs();
        std::fs::create_dir_all(roots.version_dir(Provider::OpenCode, "1.18.3")).unwrap();
        roots
            .write_current_version(Provider::OpenCode, "1.18.3")
            .unwrap();
        roots.remove_provider(Provider::OpenCode).unwrap();
        assert!(!roots.provider_dir(Provider::OpenCode).exists());
    }

    #[test]
    fn default_root_uses_local_app_data_when_set() {
        // 仅验证路径结构，不依赖具体机器值。
        let root = FileSystemRuntimeRoots::default_root();
        assert!(root.ends_with("runtimes"));
        assert!(root.to_string_lossy().contains("CodeMUX"));
    }
}
