//! Runtime Manager：SDK Runtime 的唯一管理模块。
//!
//! 负责 manifest 获取、Node 检测、Pack 下载、签名与哈希校验、解压、目录完整性校验、
//! 版本切换、失败回滚、旧版本删除和损坏 Runtime 修复。同一 Provider 的安装、更新和
//! 修复通过 per-provider mutex 提供互斥控制；并发请求收到 `Busy` 错误。
//!
//! Runtime Manager 通过依赖 `seam` 中的 trait 完成生命周期管理，生产实现注入
//! `infra` 中的具体结构，测试注入 `fixtures` 中的内存夹具。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::error::RuntimeError;
use super::manifest::RuntimeManifest;
use super::seam::{
    ArchiveExtractor, ManifestSource, NodeResolver, NoopProgressReporter, PackDownloader,
    ProgressReporter, RuntimeFileSystem, SignatureVerifier,
};
use super::signing::check_binary_executable;
use super::types::{
    Arch, InstallStage, NodeDetection, Platform, Progress, Provider, RuntimeIntegrityResult,
    RuntimeStatus, SemverVersion, SidecarCompatibility,
};

/// 安装 / 升级 / 修复操作的结果。
#[derive(Debug, Clone)]
pub struct InstallOutcome {
    pub provider: Provider,
    /// 之前安装的版本（`None` 表示首次安装）。
    pub previous_version: Option<String>,
    /// 新安装的版本。
    pub installed_version: String,
    /// 新版本安装目录绝对路径。
    pub install_path: PathBuf,
    /// 是否发生了实际版本切换（`false` 表示新版本与旧版本相同且未重新启用）。
    pub switched: bool,
}

/// Runtime 状态查询结果。
#[derive(Debug, Clone)]
pub struct RuntimeStatusInfo {
    pub provider: Provider,
    pub status: RuntimeStatus,
    pub current_version: Option<String>,
    pub install_path: Option<PathBuf>,
    pub latest_version: Option<String>,
    pub node: NodeDetection,
    pub integrity: Option<RuntimeIntegrityResult>,
    pub sidecar_compat: Option<SidecarCompatibility>,
}

/// Runtime Manager：SDK Runtime 的唯一管理模块。
///
/// 通过泛型参数注入 manifest 源、下载器、签名校验器、解压器、Node 解析器和文件系统视图，
/// 让生产实现和测试夹具共享同一套生命周期编排逻辑。
///
/// 字段使用 `Arc` 包裹，便于测试在创建 manager 后继续操作夹具（如注册 manifest、pack）。
pub struct RuntimeManager<M, D, S, E, N, F> {
    pub(crate) manifest_source: Arc<M>,
    pub(crate) pack_downloader: Arc<D>,
    pub(crate) signature_verifier: Arc<S>,
    pub(crate) archive_extractor: Arc<E>,
    pub(crate) node_resolver: Arc<N>,
    pub(crate) fs: Arc<F>,
    pub(crate) sidecar_version: String,
    pub(crate) platform: Platform,
    pub(crate) arch: Arch,
    /// per-provider 互斥锁，保证同一 Provider 的安装/更新/修复串行执行。
    locks: Mutex<HashMap<Provider, Arc<Mutex<()>>>>,
    /// 切换成功后保留的旧版本数量（不含当前版本）。默认 0，即只保留当前版本。
    pub(crate) keep_old_versions: usize,
}

impl<M, D, S, E, N, F> RuntimeManager<M, D, S, E, N, F>
where
    M: ManifestSource,
    D: PackDownloader,
    S: SignatureVerifier,
    E: ArchiveExtractor,
    N: NodeResolver,
    F: RuntimeFileSystem,
{
    /// 创建 Runtime Manager。各依赖以 `Arc` 形式注入，便于测试在创建后继续操作夹具。
    pub fn new(
        manifest_source: Arc<M>,
        pack_downloader: Arc<D>,
        signature_verifier: Arc<S>,
        archive_extractor: Arc<E>,
        node_resolver: Arc<N>,
        fs: Arc<F>,
        sidecar_version: impl Into<String>,
    ) -> Self {
        Self {
            manifest_source,
            pack_downloader,
            signature_verifier,
            archive_extractor,
            node_resolver,
            fs,
            sidecar_version: sidecar_version.into(),
            platform: Platform::current(),
            arch: Arch::current(),
            locks: Mutex::new(HashMap::new()),
            keep_old_versions: 0,
        }
    }

    /// 设置切换成功后保留的旧版本数量。
    pub fn with_keep_old_versions(mut self, count: usize) -> Self {
        self.keep_old_versions = count;
        self
    }

    /// 显式指定平台和架构（测试用；生产环境从 `Platform::current()` 推断）。
    pub fn with_target(mut self, platform: Platform, arch: Arch) -> Self {
        self.platform = platform;
        self.arch = arch;
        self
    }

    /// 检测系统 Node.js。
    pub async fn detect_node(&self) -> NodeDetection {
        self.node_resolver.detect().await
    }

    /// 列出指定 Provider 在远端的可用版本（按发布时间倒序）。
    pub async fn list_available_versions(
        &self,
        provider: Provider,
    ) -> Result<Vec<String>, RuntimeError> {
        self.manifest_source
            .list_versions(provider, self.platform, self.arch)
            .await
    }

    /// 列出指定 Provider 已安装的版本目录。
    pub fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
        self.fs.list_installed_versions(provider)
    }

    /// 读取当前启用的版本。
    pub fn current_version(&self, provider: Provider) -> Option<String> {
        self.fs.read_current_version(provider)
    }

    /// 读取当前版本的安装路径。
    pub fn current_install_path(&self, provider: Provider) -> Option<PathBuf> {
        let version = self.fs.read_current_version(provider)?;
        Some(self.fs.version_dir(provider, &version))
    }

    /// 校验指定版本目录的完整性（关键文件 + 关键二进制）。
    pub fn verify_integrity(
        &self,
        provider: Provider,
        manifest: &RuntimeManifest,
    ) -> RuntimeIntegrityResult {
        let version_dir = self.fs.version_dir(provider, &manifest.version);
        let mut missing_files = Vec::new();
        let mut missing_binaries = Vec::new();

        for file_rel in &manifest.key_files {
            let path = version_dir.join(file_rel);
            if !path.exists() {
                missing_files.push(file_rel.clone());
            }
        }
        for binary_rel in &manifest.key_binaries {
            if check_binary_executable(&version_dir, binary_rel, provider).is_err() {
                missing_binaries.push(binary_rel.clone());
            }
        }

        if missing_files.is_empty() && missing_binaries.is_empty() {
            RuntimeIntegrityResult::ok()
        } else {
            RuntimeIntegrityResult::failed(missing_files, missing_binaries)
        }
    }

    /// 校验当前已安装版本的完整性。若未安装或 manifest 拉取失败，返回 `None`。
    pub async fn check_integrity(
        &self,
        provider: Provider,
    ) -> Result<Option<RuntimeIntegrityResult>, RuntimeError> {
        let version = match self.fs.read_current_version(provider) {
            Some(v) => v,
            None => return Ok(None),
        };
        let manifest = self
            .manifest_source
            .fetch_version(provider, self.platform, self.arch, &version)
            .await?;
        Ok(Some(self.verify_integrity(provider, &manifest)))
    }

    /// 检查 sidecar 兼容性。
    pub fn check_sidecar_compat(&self, manifest: &RuntimeManifest) -> SidecarCompatibility {
        let required_range = manifest.sidecar_compat.clone();
        let satisfied = evaluate_sidecar_compat(&self.sidecar_version, &required_range);
        SidecarCompatibility {
            sidecar_version: self.sidecar_version.clone(),
            required_range,
            satisfied,
        }
    }

    /// 查询指定 Provider 的运行时状态。
    pub async fn check_status(
        &self,
        provider: Provider,
    ) -> Result<RuntimeStatusInfo, RuntimeError> {
        let node = self.node_resolver.detect().await;
        if !node.satisfies_minimum {
            return Ok(RuntimeStatusInfo {
                provider,
                status: RuntimeStatus::NodeUnavailable,
                current_version: None,
                install_path: None,
                latest_version: None,
                node,
                integrity: None,
                sidecar_compat: None,
            });
        }

        let latest_version = self
            .manifest_source
            .fetch_latest(provider, self.platform, self.arch)
            .await
            .map(|m| Some(m.version))
            .unwrap_or(None);

        let current_version = self.fs.read_current_version(provider);
        let install_path = current_version
            .as_ref()
            .map(|v| self.fs.version_dir(provider, v));

        if current_version.is_none() {
            return Ok(RuntimeStatusInfo {
                provider,
                status: RuntimeStatus::Missing,
                current_version: None,
                install_path: None,
                latest_version,
                node,
                integrity: None,
                sidecar_compat: None,
            });
        }

        // 校验完整性
        let integrity = self.check_integrity(provider).await.unwrap_or(None);
        let status = match &integrity {
            Some(result) if !result.ok => RuntimeStatus::Corrupted,
            _ => match (&current_version, &latest_version) {
                (Some(cur), Some(latest)) if is_newer_version(latest, cur) => {
                    RuntimeStatus::Outdated
                }
                _ => RuntimeStatus::Ready,
            },
        };

        Ok(RuntimeStatusInfo {
            provider,
            status,
            current_version,
            install_path,
            latest_version,
            node,
            integrity,
            sidecar_compat: None,
        })
    }

    /// 安装指定 Provider 的最新版本。即使已安装相同版本也会重新下载并切换。
    pub async fn install(
        &self,
        provider: Provider,
        progress: Option<Box<dyn ProgressReporter>>,
    ) -> Result<InstallOutcome, RuntimeError> {
        let progress: Box<dyn ProgressReporter> =
            progress.unwrap_or_else(|| Box::new(NoopProgressReporter));
        let _guard = self.try_acquire_lock(provider).await?;

        progress
            .report(
                Progress::new(InstallStage::Resolving)
                    .with_message(format!("正在获取 {} 最新 manifest", provider.label())),
            )
            .await;
        let manifest = self
            .manifest_source
            .fetch_latest(provider, self.platform, self.arch)
            .await?;
        self.install_manifest(provider, manifest, progress.as_ref())
            .await
    }

    /// 安装指定 Provider 的指定版本。
    pub async fn install_version(
        &self,
        provider: Provider,
        version: &str,
        progress: Option<Box<dyn ProgressReporter>>,
    ) -> Result<InstallOutcome, RuntimeError> {
        let progress: Box<dyn ProgressReporter> =
            progress.unwrap_or_else(|| Box::new(NoopProgressReporter));
        let _guard = self.try_acquire_lock(provider).await?;

        progress
            .report(Progress::new(InstallStage::Resolving).with_message(format!(
                "正在获取 {} 版本 {} manifest",
                provider.label(),
                version
            )))
            .await;
        let manifest = self
            .manifest_source
            .fetch_version(provider, self.platform, self.arch, version)
            .await?;
        self.install_manifest(provider, manifest, progress.as_ref())
            .await
    }

    /// 升级到最新版本。若当前已是最新版，返回 `None`。
    pub async fn upgrade(
        &self,
        provider: Provider,
        progress: Option<Box<dyn ProgressReporter>>,
    ) -> Result<Option<InstallOutcome>, RuntimeError> {
        let progress: Box<dyn ProgressReporter> =
            progress.unwrap_or_else(|| Box::new(NoopProgressReporter));
        let _guard = self.try_acquire_lock(provider).await?;

        progress
            .report(
                Progress::new(InstallStage::Resolving)
                    .with_message(format!("正在检查 {} 可用更新", provider.label())),
            )
            .await;
        let manifest = self
            .manifest_source
            .fetch_latest(provider, self.platform, self.arch)
            .await?;

        let current = self.fs.read_current_version(provider);
        if let Some(ref cur) = current {
            if cur == &manifest.version {
                // 已是最新版，无需升级
                progress
                    .report(Progress::new(InstallStage::Done).with_message(format!(
                        "{} 已是最新版本 {}",
                        provider.label(),
                        cur
                    )))
                    .await;
                return Ok(None);
            }
        }

        let outcome = self
            .install_manifest(provider, manifest, progress.as_ref())
            .await?;
        Ok(Some(outcome))
    }

    /// 修复当前版本。若当前版本完整，返回 `None`；否则重新下载并安装当前版本。
    /// 若无当前版本（未安装），则安装最新版。
    pub async fn repair(
        &self,
        provider: Provider,
        progress: Option<Box<dyn ProgressReporter>>,
    ) -> Result<Option<InstallOutcome>, RuntimeError> {
        let progress: Box<dyn ProgressReporter> =
            progress.unwrap_or_else(|| Box::new(NoopProgressReporter));
        let _guard = self.try_acquire_lock(provider).await?;

        let current = self.fs.read_current_version(provider);
        match current {
            Some(version) => {
                progress
                    .report(
                        Progress::new(InstallStage::VerifyingIntegrity).with_message(format!(
                            "正在校验 {} 当前版本 {} 完整性",
                            provider.label(),
                            version
                        )),
                    )
                    .await;
                // 拉取当前版本 manifest 并校验完整性
                let manifest = match self
                    .manifest_source
                    .fetch_version(provider, self.platform, self.arch, &version)
                    .await
                {
                    Ok(m) => m,
                    Err(_) => {
                        // manifest 拉取失败，回退到安装最新版
                        let latest = self
                            .manifest_source
                            .fetch_latest(provider, self.platform, self.arch)
                            .await?;
                        let outcome = self
                            .install_manifest(provider, latest, progress.as_ref())
                            .await?;
                        return Ok(Some(outcome));
                    }
                };
                let integrity = self.verify_integrity(provider, &manifest);
                if integrity.ok {
                    // 完整性正常，无需修复
                    progress
                        .report(Progress::new(InstallStage::Done).with_message(format!(
                            "{} {} 完整性正常，无需修复",
                            provider.label(),
                            version
                        )))
                        .await;
                    return Ok(None);
                }
                // 完整性失败，重新安装当前版本
                let outcome = self
                    .install_manifest(provider, manifest, progress.as_ref())
                    .await?;
                Ok(Some(outcome))
            }
            None => {
                // 未安装，安装最新版
                let manifest = self
                    .manifest_source
                    .fetch_latest(provider, self.platform, self.arch)
                    .await?;
                let outcome = self
                    .install_manifest(provider, manifest, progress.as_ref())
                    .await?;
                Ok(Some(outcome))
            }
        }
    }

    /// 删除指定 Provider 的所有版本和当前版本指针。
    pub async fn remove(&self, provider: Provider) -> Result<(), RuntimeError> {
        // remove 也需要持锁，避免与正在进行的 install 冲突
        let _guard = self.try_acquire_lock(provider).await?;
        // 删除整个 provider 目录（包含所有版本和 current 指针）
        self.fs.remove_provider(provider)
    }

    /// 切换当前版本指针到指定版本。仅切换指针，不下载或校验。
    /// 要求目标版本目录已存在。
    pub async fn switch_version(
        &self,
        provider: Provider,
        version: &str,
    ) -> Result<(), RuntimeError> {
        let _guard = self.try_acquire_lock(provider).await?;
        let version_dir = self.fs.version_dir(provider, version);
        if !version_dir.exists() {
            return Err(RuntimeError::integrity_failed(
                Some(provider),
                format!("版本 {} 目录不存在：{}", version, version_dir.display()),
            ));
        }
        let previous = self.fs.read_current_version(provider);
        self.fs.write_current_version(provider, version)?;
        // 读回校验
        let read_back = self.fs.read_current_version(provider);
        if read_back.as_deref() != Some(version) {
            // 回滚
            if let Some(prev) = previous {
                let _ = self.fs.write_current_version(provider, &prev);
            }
            return Err(RuntimeError::rollback_failed(
                Some(provider),
                format!(
                    "切换版本指针后读回校验失败：期望 {}，实际 {:?}",
                    version, read_back
                ),
            ));
        }
        Ok(())
    }

    /// 清理旧版本。保留当前版本 + `keep_old_versions` 个最近版本，删除其余。
    pub fn cleanup_old_versions(&self, provider: Provider) -> Result<usize, RuntimeError> {
        let current = match self.fs.read_current_version(provider) {
            Some(v) => v,
            None => return Ok(0),
        };
        let mut versions = self.fs.list_installed_versions(provider);
        // 排除当前版本
        versions.retain(|v| v != &current);
        // 按版本号降序排序（保留较新的旧版本）
        versions.sort_by(|a, b| b.cmp(a));

        let to_keep = self.keep_old_versions;
        let to_remove: Vec<String> = if versions.len() > to_keep {
            versions[to_keep..].to_vec()
        } else {
            Vec::new()
        };

        let mut removed = 0;
        for version in &to_remove {
            self.fs.remove_version(provider, version)?;
            removed += 1;
        }
        Ok(removed)
    }

    /// 内部：获取 per-provider 锁。若已持有，返回 `Busy` 错误。
    async fn try_acquire_lock(
        &self,
        provider: Provider,
    ) -> Result<ProviderLockGuard, RuntimeError> {
        let arc = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(provider)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        match arc.try_lock_owned() {
            Ok(guard) => Ok(ProviderLockGuard { _guard: guard }),
            Err(_) => Err(RuntimeError::busy(provider)),
        }
    }

    /// 内部：执行完整的安装流程（下载 → 校验 → 解压 → 完整性 → 切换 → 清理）。
    /// 调用方必须在调用前已获取 per-provider 锁。
    async fn install_manifest(
        &self,
        provider: Provider,
        manifest: RuntimeManifest,
        progress: &dyn ProgressReporter,
    ) -> Result<InstallOutcome, RuntimeError> {
        // 1. Node 检测
        let node = self.node_resolver.detect().await;
        if !node.satisfies_minimum {
            return Err(RuntimeError::node_unavailable(format!(
                "Node.js 不可用或版本低于 18：{}",
                node.error.unwrap_or_else(|| "未知原因".to_string())
            )));
        }

        // 2. 校验 manifest 自身
        manifest.validate().map_err(|msg| {
            RuntimeError::manifest_failed(Some(provider), format!("manifest 校验失败: {}", msg))
        })?;

        // 3. 校验 sidecar 兼容性
        let compat = self.check_sidecar_compat(&manifest);
        if !compat.satisfied {
            return Err(RuntimeError::compatibility_failed(
                Some(provider),
                format!(
                    "sidecar 兼容性不匹配：当前 sidecar {}，manifest 要求 {}",
                    compat.sidecar_version, compat.required_range
                ),
            ));
        }

        let previous_version = self.fs.read_current_version(provider);
        let new_version = manifest.version.clone();
        let new_version_dir = self.fs.version_dir(provider, &new_version);

        // 若新版本目录已存在（如上次安装中断残留），先删除
        if new_version_dir.exists() {
            self.fs
                .remove_version(provider, &new_version)
                .map_err(|e| {
                    RuntimeError::io_failed(
                        Some(provider),
                        format!("无法清理残留版本目录 {}: {}", new_version_dir.display(), e),
                    )
                })?;
        }

        // 4. 下载 Pack
        progress
            .report(
                Progress::new(InstallStage::Downloading).with_message(format!(
                    "正在下载 {} {} Pack",
                    provider.label(),
                    new_version
                )),
            )
            .await;
        let pack_path = self
            .pack_downloader
            .download(&manifest, Box::new(NoopProgressReporter))
            .await?;

        // 5. 校验签名 + SHA-256
        progress
            .report(
                Progress::new(InstallStage::VerifyingSignature).with_message("正在校验 Pack 签名"),
            )
            .await;
        self.signature_verifier
            .verify(&manifest, &pack_path)
            .await?;

        // 6. 解压到新版本目录
        progress
            .report(
                Progress::new(InstallStage::Extracting)
                    .with_message(format!("正在解压到 {}", new_version_dir.display())),
            )
            .await;
        // 确保父目录存在
        if let Some(parent) = new_version_dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                RuntimeError::io_failed(
                    Some(provider),
                    format!("无法创建 Provider 目录 {}: {}", parent.display(), e),
                )
            })?;
        }
        std::fs::create_dir_all(&new_version_dir).map_err(|e| {
            RuntimeError::io_failed(
                Some(provider),
                format!("无法创建版本目录 {}: {}", new_version_dir.display(), e),
            )
        })?;
        self.archive_extractor
            .extract(&pack_path, &new_version_dir)
            .await?;

        // 7. 校验完整性
        progress
            .report(
                Progress::new(InstallStage::VerifyingIntegrity)
                    .with_message("正在校验关键文件和二进制"),
            )
            .await;
        let integrity = self.verify_integrity(provider, &manifest);
        if !integrity.ok {
            // 完整性失败，清理新版本目录
            let _ = self.fs.remove_version(provider, &new_version);
            // 清理临时 Pack 文件
            let _ = std::fs::remove_file(&pack_path);
            return Err(RuntimeError::integrity_failed(
                Some(provider),
                format!("完整性校验失败: {}", integrity.message),
            ));
        }

        // 8. 切换当前版本指针
        progress
            .report(
                Progress::new(InstallStage::Switching)
                    .with_message(format!("正在切换到版本 {}", new_version)),
            )
            .await;
        // 原子切换：先写新指针，读回校验；失败则回滚到旧指针
        self.fs.write_current_version(provider, &new_version)?;
        let read_back = self.fs.read_current_version(provider);
        if read_back.as_deref() != Some(new_version.as_str()) {
            // 回滚
            if let Some(ref prev) = previous_version {
                if let Err(rollback_err) = self.fs.write_current_version(provider, prev) {
                    // 回滚也失败，清理临时文件并返回 RollbackFailed
                    let _ = std::fs::remove_file(&pack_path);
                    return Err(RuntimeError::rollback_failed(
                        Some(provider),
                        format!(
                            "切换指针失败且回滚也失败：原始读回={:?}, 回滚错误={}",
                            read_back, rollback_err
                        ),
                    ));
                }
            } else {
                // 没有旧版本可回滚，清理新版本目录
                let _ = self.fs.remove_version(provider, &new_version);
            }
            let _ = std::fs::remove_file(&pack_path);
            return Err(RuntimeError::rollback_failed(
                Some(provider),
                format!(
                    "切换版本指针后读回校验失败：期望 {}，实际 {:?}",
                    new_version, read_back
                ),
            ));
        }

        let switched = previous_version.as_deref() != Some(new_version.as_str());

        // 9. 清理旧版本
        progress
            .report(Progress::new(InstallStage::Cleaning).with_message("正在清理旧版本"))
            .await;
        if let Err(e) = self.cleanup_old_versions(provider) {
            // 清理失败不影响安装结果，但记录警告
            log::warn!(
                target: "runtime",
                "清理 {} 旧版本失败（不影响安装）: {}",
                provider.as_str(),
                e
            );
        }

        // 10. 清理临时 Pack 文件
        let _ = std::fs::remove_file(&pack_path);

        // 11. 完成
        progress
            .report(Progress::new(InstallStage::Done).with_message(format!(
                "{} {} 安装完成",
                provider.label(),
                new_version
            )))
            .await;

        Ok(InstallOutcome {
            provider,
            previous_version,
            installed_version: new_version,
            install_path: new_version_dir,
            switched,
        })
    }
}

/// per-provider 锁的 guard。drop 时自动释放锁。
struct ProviderLockGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

/// 评估 sidecar 版本是否满足 manifest 声明的兼容范围。
/// 当前支持简单语义：`>=x.y.z`、`>x.y.z`、`=x.y.z`。其他格式退化为字符串相等比较。
fn evaluate_sidecar_compat(sidecar_version: &str, required_range: &str) -> bool {
    let range = required_range.trim();
    let sidecar = sidecar_version.trim();

    if let Some(min) = range.strip_prefix(">=") {
        let min = min.trim();
        match (SemverVersion::parse(sidecar), SemverVersion::parse(min)) {
            (Some(s), Some(m)) => (s.major, s.minor, s.patch) >= (m.major, m.minor, m.patch),
            _ => sidecar == min,
        }
    } else if let Some(min) = range.strip_prefix(">") {
        let min = min.trim();
        match (SemverVersion::parse(sidecar), SemverVersion::parse(min)) {
            (Some(s), Some(m)) => (s.major, s.minor, s.patch) > (m.major, m.minor, m.patch),
            _ => false,
        }
    } else if let Some(rest) = range.strip_prefix("=") {
        sidecar == rest.trim()
    } else {
        // 未知格式，退化为字符串相等
        sidecar == range
    }
}

/// 判断 `candidate` 是否比 `current` 更新。
fn is_newer_version(candidate: &str, current: &str) -> bool {
    match (
        SemverVersion::parse(candidate),
        SemverVersion::parse(current),
    ) {
        (Some(c), Some(cur)) => c.is_newer_than(&cur),
        _ => candidate != current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::fixtures::{
        FixedNodeResolver, FixedSignatureVerifier, InMemoryArchiveExtractor,
        InMemoryManifestSource, InMemoryPackDownloader, TempRuntimeFileSystem,
    };
    use crate::runtime::manifest::RuntimeManifestAsset;
    use crate::runtime::seam::{PackDownloader, ProgressReporter, RuntimeFileSystem};
    use crate::runtime::RuntimeErrorKind;

    use async_trait::async_trait;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::sync::{mpsc, Notify};

    // ===== Helpers =====

    fn sample_manifest(provider: Provider, version: &str) -> RuntimeManifest {
        RuntimeManifest {
            schema_version: crate::runtime::manifest::MANIFEST_SCHEMA_VERSION,
            provider,
            version: version.to_string(),
            platform: Platform::Windows,
            arch: Arch::X64,
            asset: RuntimeManifestAsset {
                url: format!(
                    "https://example.com/{}-{}.tar.gz",
                    provider.as_str(),
                    version
                ),
                size_bytes: 100,
                sha256: "a".repeat(64),
                signature: "sig".to_string(),
            },
            sidecar_compat: ">=0.2.0".to_string(),
            key_files: vec!["package.json".to_string()],
            key_binaries: vec!["bin/agent.exe".to_string()],
            created_at: "2026-08-05T00:00:00Z".to_string(),
        }
    }

    fn manifest_with_sidecar(
        provider: Provider,
        version: &str,
        sidecar_compat: &str,
    ) -> RuntimeManifest {
        let mut m = sample_manifest(provider, version);
        m.sidecar_compat = sidecar_compat.to_string();
        m
    }

    /// 在 `parent` 下创建完整的 Pack 源目录（含 package.json 和 bin/agent.exe）。
    fn create_pack_source_dir(parent: &Path) -> PathBuf {
        let dir = parent.join("pack-source");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("package.json"), b"{}").unwrap();
        std::fs::write(dir.join("bin").join("agent.exe"), b"binary").unwrap();
        dir
    }

    /// 在 `parent` 下创建不完整的 Pack 源目录（缺少 bin/agent.exe），用于完整性校验失败测试。
    fn create_incomplete_pack_source_dir(parent: &Path) -> PathBuf {
        let dir = parent.join("pack-incomplete");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), b"{}").unwrap();
        // 故意不创建 bin/agent.exe
        dir
    }

    /// 构建完整的测试环境：所有依赖满足，ClaudeCode 0.3.170 manifest 和 pack 已注册。
    struct TestEnv {
        manager: RuntimeManager<
            InMemoryManifestSource,
            InMemoryPackDownloader,
            FixedSignatureVerifier,
            InMemoryArchiveExtractor,
            FixedNodeResolver,
            TempRuntimeFileSystem,
        >,
        manifest_source: Arc<InMemoryManifestSource>,
        pack_downloader: Arc<InMemoryPackDownloader>,
        archive_extractor: Arc<InMemoryArchiveExtractor>,
        fs: Arc<TempRuntimeFileSystem>,
        _pack_tmp: tempfile::TempDir,
    }

    fn build_env() -> TestEnv {
        build_env_with(
            FixedNodeResolver::satisfied(),
            FixedSignatureVerifier::passing(),
        )
    }

    fn build_env_with(node: FixedNodeResolver, verifier: FixedSignatureVerifier) -> TestEnv {
        let manifest_source = Arc::new(InMemoryManifestSource::new());
        let pack_downloader = Arc::new(InMemoryPackDownloader::new());
        let signature_verifier = Arc::new(verifier);
        let archive_extractor = Arc::new(InMemoryArchiveExtractor::new());
        let node_resolver = Arc::new(node);
        let fs = Arc::new(TempRuntimeFileSystem::new());

        let manager = RuntimeManager::new(
            manifest_source.clone(),
            pack_downloader.clone(),
            signature_verifier,
            archive_extractor.clone(),
            node_resolver,
            fs.clone(),
            "0.2.0",
        )
        .with_target(Platform::Windows, Arch::X64)
        .with_keep_old_versions(1);

        let pack_tmp = tempfile::TempDir::new().unwrap();
        let pack_source_dir = create_pack_source_dir(pack_tmp.path());
        archive_extractor.register_default_source(pack_source_dir);

        let manifest = sample_manifest(Provider::ClaudeCode, "0.3.170");
        manifest_source.register(manifest.clone());
        pack_downloader.register_pack(manifest.asset.url.clone(), vec![1, 2, 3, 4]);

        TestEnv {
            manager,
            manifest_source,
            pack_downloader,
            archive_extractor,
            fs,
            _pack_tmp: pack_tmp,
        }
    }

    // ===== Helper function unit tests =====

    #[test]
    fn evaluate_sidecar_compat_supports_gte() {
        assert!(evaluate_sidecar_compat("0.2.0", ">=0.2.0"));
        assert!(evaluate_sidecar_compat("0.3.0", ">=0.2.0"));
        assert!(!evaluate_sidecar_compat("0.1.0", ">=0.2.0"));
    }

    #[test]
    fn evaluate_sidecar_compat_supports_gt() {
        assert!(evaluate_sidecar_compat("0.3.0", ">0.2.0"));
        assert!(!evaluate_sidecar_compat("0.2.0", ">0.2.0"));
    }

    #[test]
    fn evaluate_sidecar_compat_supports_eq() {
        assert!(evaluate_sidecar_compat("0.2.0", "=0.2.0"));
        assert!(!evaluate_sidecar_compat("0.3.0", "=0.2.0"));
    }

    #[test]
    fn evaluate_sidecar_compat_falls_back_to_string_eq() {
        assert!(evaluate_sidecar_compat("0.2.0", "0.2.0"));
        assert!(!evaluate_sidecar_compat("0.3.0", "0.2.0"));
    }

    #[test]
    fn is_newer_version_uses_semver() {
        assert!(is_newer_version("0.3.170", "0.3.169"));
        assert!(!is_newer_version("0.3.169", "0.3.170"));
        assert!(!is_newer_version("0.3.170", "0.3.170"));
    }

    // ===== Node 检测测试 =====

    #[tokio::test]
    async fn install_fails_when_node_unavailable() {
        let env = build_env_with(
            FixedNodeResolver::unavailable(),
            FixedSignatureVerifier::passing(),
        );
        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::NodeUnavailable);
        // 未安装任何版本
        assert!(env.fs.read_current_version(Provider::ClaudeCode).is_none());
    }

    #[tokio::test]
    async fn install_fails_when_node_too_old() {
        let env = build_env_with(
            FixedNodeResolver::too_old(),
            FixedSignatureVerifier::passing(),
        );
        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::NodeUnavailable);
    }

    #[tokio::test]
    async fn install_succeeds_when_node_satisfied() {
        let env = build_env();
        let outcome = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.170".to_string())
        );
    }

    // ===== Manifest 失败测试 =====

    #[tokio::test]
    async fn install_fails_when_manifest_missing_for_provider() {
        let env = build_env();
        // Codex 没有注册 manifest
        let err = env
            .manager
            .install(Provider::Codex, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::ManifestFailed);
    }

    #[tokio::test]
    async fn install_fails_when_manifest_validation_fails() {
        let env = build_env();
        // 覆盖注册一个 schema_version 错误的 manifest
        let mut bad = sample_manifest(Provider::ClaudeCode, "0.3.170");
        bad.schema_version = 99;
        env.manifest_source.register(bad);

        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::ManifestFailed);
    }

    // ===== Sidecar 兼容性测试 =====

    #[tokio::test]
    async fn install_fails_when_sidecar_incompatible() {
        let env = build_env();
        // 覆盖注册一个要求 sidecar >=0.3.0 的 manifest（当前 sidecar 0.2.0）
        let m = manifest_with_sidecar(Provider::ClaudeCode, "0.3.170", ">=0.3.0");
        env.manifest_source.register(m);

        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::CompatibilityFailed);
    }

    // ===== 下载失败测试 =====

    #[tokio::test]
    async fn install_fails_when_download_fails() {
        let env = build_env();
        // 覆盖注册一个 URL 不同的 manifest（pack 未注册）
        let mut m = sample_manifest(Provider::ClaudeCode, "0.3.170");
        m.asset.url = "https://example.com/unregistered-pack.tar.gz".to_string();
        env.manifest_source.register(m);

        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::DownloadFailed);
    }

    // ===== 签名和哈希失败测试 =====

    #[tokio::test]
    async fn install_fails_on_signature_error() {
        let env = build_env_with(
            FixedNodeResolver::satisfied(),
            FixedSignatureVerifier::failing(),
        );
        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::SignatureError);
        // 失败后不应切换版本
        assert!(env.fs.read_current_version(Provider::ClaudeCode).is_none());
    }

    #[tokio::test]
    async fn install_fails_on_hash_mismatch() {
        let env = build_env_with(
            FixedNodeResolver::satisfied(),
            FixedSignatureVerifier::failing_with(RuntimeError::hash_mismatch(
                None,
                "SHA-256 不匹配（测试模拟）",
            )),
        );
        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::HashMismatch);
    }

    // ===== 解压失败测试 =====

    #[tokio::test]
    async fn install_fails_on_extraction_error() {
        let env = build_env();
        env.archive_extractor
            .fail_next_with(RuntimeError::extract_failed(
                Some(Provider::ClaudeCode),
                "模拟解压失败：磁盘空间不足",
            ));
        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::ExtractFailed);
        // 失败后不应切换版本
        assert!(env.fs.read_current_version(Provider::ClaudeCode).is_none());
    }

    // ===== 完整性失败测试 =====

    #[tokio::test]
    async fn install_fails_on_integrity_failure() {
        let env = build_env();
        // 覆盖默认源目录为不完整的源（缺少 bin/agent.exe）
        let incomplete_dir = create_incomplete_pack_source_dir(env._pack_tmp.path());
        env.archive_extractor
            .register_default_source(incomplete_dir);

        let err = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::IntegrityFailed);
        // 失败后应清理新版本目录
        assert!(env.fs.read_current_version(Provider::ClaudeCode).is_none());
        assert!(env
            .fs
            .list_installed_versions(Provider::ClaudeCode)
            .is_empty());
    }

    // ===== 权限失败测试 =====

    /// 包装 `TempRuntimeFileSystem`，`write_current_version` 总是返回 `PermissionFailed`。
    struct PermissionDeniedFileSystem {
        inner: TempRuntimeFileSystem,
    }

    impl RuntimeFileSystem for PermissionDeniedFileSystem {
        fn root(&self) -> PathBuf {
            self.inner.root()
        }
        fn read_current_version(&self, provider: Provider) -> Option<String> {
            self.inner.read_current_version(provider)
        }
        fn write_current_version(
            &self,
            provider: Provider,
            _version: &str,
        ) -> Result<(), RuntimeError> {
            Err(RuntimeError::permission_failed(
                Some(provider),
                "模拟权限不足：无法写入当前版本指针",
            ))
        }
        fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
            self.inner.list_installed_versions(provider)
        }
        fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
            self.inner.remove_version(provider, version)
        }
        fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError> {
            self.inner.remove_provider(provider)
        }
    }

    #[tokio::test]
    async fn install_fails_on_write_permission_error() {
        let manifest_source = Arc::new(InMemoryManifestSource::new());
        let pack_downloader = Arc::new(InMemoryPackDownloader::new());
        let archive_extractor = Arc::new(InMemoryArchiveExtractor::new());
        let fs = Arc::new(PermissionDeniedFileSystem {
            inner: TempRuntimeFileSystem::new(),
        });

        let manager = RuntimeManager::new(
            manifest_source.clone(),
            pack_downloader.clone(),
            Arc::new(FixedSignatureVerifier::passing()),
            archive_extractor.clone(),
            Arc::new(FixedNodeResolver::satisfied()),
            fs.clone(),
            "0.2.0",
        )
        .with_target(Platform::Windows, Arch::X64);

        let pack_tmp = tempfile::TempDir::new().unwrap();
        archive_extractor.register_default_source(create_pack_source_dir(pack_tmp.path()));

        let manifest = sample_manifest(Provider::ClaudeCode, "0.3.170");
        manifest_source.register(manifest.clone());
        pack_downloader.register_pack(manifest.asset.url.clone(), vec![1, 2, 3, 4]);

        let err = manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::PermissionFailed);
    }

    // ===== 回滚失败测试 =====

    /// 包装 `TempRuntimeFileSystem`，在首次 `write_current_version` 后让
    /// `read_current_version` 返回错误值，触发版本切换的读回校验失败 → 回滚路径。
    struct CorruptingFileSystem {
        inner: TempRuntimeFileSystem,
        write_count: AtomicU32,
    }

    impl CorruptingFileSystem {
        fn new() -> Self {
            Self {
                inner: TempRuntimeFileSystem::new(),
                write_count: AtomicU32::new(0),
            }
        }
    }

    impl RuntimeFileSystem for CorruptingFileSystem {
        fn root(&self) -> PathBuf {
            self.inner.root()
        }
        fn read_current_version(&self, provider: Provider) -> Option<String> {
            if self.write_count.load(Ordering::SeqCst) > 0 {
                return Some("__corrupted__".to_string());
            }
            self.inner.read_current_version(provider)
        }
        fn write_current_version(
            &self,
            provider: Provider,
            version: &str,
        ) -> Result<(), RuntimeError> {
            self.write_count.fetch_add(1, Ordering::SeqCst);
            self.inner.write_current_version(provider, version)
        }
        fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
            self.inner.list_installed_versions(provider)
        }
        fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
            self.inner.remove_version(provider, version)
        }
        fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError> {
            self.inner.remove_provider(provider)
        }
    }

    #[tokio::test]
    async fn install_fails_on_rollback_failure() {
        let manifest_source = Arc::new(InMemoryManifestSource::new());
        let pack_downloader = Arc::new(InMemoryPackDownloader::new());
        let archive_extractor = Arc::new(InMemoryArchiveExtractor::new());
        let fs = Arc::new(CorruptingFileSystem::new());

        let manager = RuntimeManager::new(
            manifest_source.clone(),
            pack_downloader.clone(),
            Arc::new(FixedSignatureVerifier::passing()),
            archive_extractor.clone(),
            Arc::new(FixedNodeResolver::satisfied()),
            fs.clone(),
            "0.2.0",
        )
        .with_target(Platform::Windows, Arch::X64);

        let pack_tmp = tempfile::TempDir::new().unwrap();
        archive_extractor.register_default_source(create_pack_source_dir(pack_tmp.path()));

        let manifest = sample_manifest(Provider::ClaudeCode, "0.3.170");
        manifest_source.register(manifest.clone());
        pack_downloader.register_pack(manifest.asset.url.clone(), vec![1, 2, 3, 4]);

        let err = manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::RollbackFailed);
    }

    // ===== 成功路径测试 =====

    #[tokio::test]
    async fn install_completes_and_switches_version() {
        let env = build_env();
        let outcome = env
            .manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
        assert!(outcome.previous_version.is_none());
        assert!(outcome.switched);
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.170".to_string())
        );
        assert!(outcome.install_path.exists());
    }

    #[tokio::test]
    async fn upgrade_skips_when_already_latest() {
        let env = build_env();
        // 先安装
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        // 再次 upgrade → 已是最新版
        let result = env
            .manager
            .upgrade(Provider::ClaudeCode, None)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn upgrade_installs_new_version() {
        let env = build_env();
        // 注册旧版本并安装
        let old = sample_manifest(Provider::ClaudeCode, "0.3.169");
        env.manifest_source.register(old.clone());
        env.pack_downloader
            .register_pack(old.asset.url.clone(), vec![5, 6]);
        env.manager
            .install_version(Provider::ClaudeCode, "0.3.169", None)
            .await
            .unwrap();
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.169".to_string())
        );

        // upgrade → 0.3.170（最新版）
        let outcome = env
            .manager
            .upgrade(Provider::ClaudeCode, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
        assert_eq!(outcome.previous_version.as_deref(), Some("0.3.169"));
        assert!(outcome.switched);
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.170".to_string())
        );
    }

    #[tokio::test]
    async fn repair_installs_latest_when_not_installed() {
        let env = build_env();
        let outcome = env
            .manager
            .repair(Provider::ClaudeCode, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
    }

    #[tokio::test]
    async fn repair_returns_none_when_intact() {
        let env = build_env();
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        let result = env
            .manager
            .repair(Provider::ClaudeCode, None)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn repair_reinstalls_when_corrupted() {
        let env = build_env();
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();

        // 删除关键文件模拟损坏
        let version_dir = env.fs.version_dir(Provider::ClaudeCode, "0.3.170");
        let _ = std::fs::remove_file(version_dir.join("bin").join("agent.exe"));

        let outcome = env
            .manager
            .repair(Provider::ClaudeCode, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
        // 修复后文件应恢复
        assert!(version_dir.join("bin").join("agent.exe").exists());
    }

    #[tokio::test]
    async fn remove_clears_all_versions() {
        let env = build_env();
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        assert!(env.fs.provider_dir(Provider::ClaudeCode).exists());

        env.manager.remove(Provider::ClaudeCode).await.unwrap();
        assert!(!env.fs.provider_dir(Provider::ClaudeCode).exists());
        assert!(env.fs.read_current_version(Provider::ClaudeCode).is_none());
    }

    #[tokio::test]
    async fn switch_version_changes_pointer() {
        let env = build_env();
        // 注册并安装两个版本
        let old = sample_manifest(Provider::ClaudeCode, "0.3.169");
        env.manifest_source.register(old.clone());
        env.pack_downloader
            .register_pack(old.asset.url.clone(), vec![5, 6]);

        env.manager
            .install_version(Provider::ClaudeCode, "0.3.169", None)
            .await
            .unwrap();
        env.manager
            .install_version(Provider::ClaudeCode, "0.3.170", None)
            .await
            .unwrap();
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.170".to_string())
        );

        // 切换回旧版本
        env.manager
            .switch_version(Provider::ClaudeCode, "0.3.169")
            .await
            .unwrap();
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.169".to_string())
        );
    }

    #[tokio::test]
    async fn cleanup_old_versions_respects_keep_count() {
        let env = build_env();
        // 注册三个版本
        for v in ["0.3.168", "0.3.169", "0.3.170"] {
            let m = sample_manifest(Provider::ClaudeCode, v);
            env.manifest_source.register(m.clone());
            env.pack_downloader
                .register_pack(m.asset.url.clone(), vec![1]);
        }

        // 使用 keep_old_versions = 1
        let manager = RuntimeManager::new(
            env.manifest_source.clone(),
            env.pack_downloader.clone(),
            Arc::new(FixedSignatureVerifier::passing()),
            env.archive_extractor.clone(),
            Arc::new(FixedNodeResolver::satisfied()),
            env.fs.clone(),
            "0.2.0",
        )
        .with_target(Platform::Windows, Arch::X64)
        .with_keep_old_versions(1);

        // 安装三个版本（每次安装会触发 cleanup）
        manager
            .install_version(Provider::ClaudeCode, "0.3.168", None)
            .await
            .unwrap();
        manager
            .install_version(Provider::ClaudeCode, "0.3.169", None)
            .await
            .unwrap();
        manager
            .install_version(Provider::ClaudeCode, "0.3.170", None)
            .await
            .unwrap();

        let installed = env.fs.list_installed_versions(Provider::ClaudeCode);
        // 当前版本 + 1 个旧版本 = 2
        assert_eq!(installed.len(), 2);
        assert!(installed.contains(&"0.3.170".to_string()));
        assert!(installed.contains(&"0.3.169".to_string()));
        assert!(!installed.contains(&"0.3.168".to_string()));
    }

    #[tokio::test]
    async fn check_status_reports_missing_when_not_installed() {
        let env = build_env();
        let info = env
            .manager
            .check_status(Provider::ClaudeCode)
            .await
            .unwrap();
        assert_eq!(info.status, RuntimeStatus::Missing);
        assert!(info.current_version.is_none());
    }

    #[tokio::test]
    async fn check_status_reports_ready_when_installed() {
        let env = build_env();
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();
        let info = env
            .manager
            .check_status(Provider::ClaudeCode)
            .await
            .unwrap();
        assert_eq!(info.status, RuntimeStatus::Ready);
        assert_eq!(info.current_version.as_deref(), Some("0.3.170"));
    }

    #[tokio::test]
    async fn check_status_reports_outdated_when_behind() {
        let env = build_env();
        // 注册旧版本并安装
        let old = sample_manifest(Provider::ClaudeCode, "0.3.169");
        env.manifest_source.register(old.clone());
        env.pack_downloader
            .register_pack(old.asset.url.clone(), vec![5, 6]);
        env.manager
            .install_version(Provider::ClaudeCode, "0.3.169", None)
            .await
            .unwrap();
        // 0.3.170 仍注册为最新版
        let info = env
            .manager
            .check_status(Provider::ClaudeCode)
            .await
            .unwrap();
        assert_eq!(info.status, RuntimeStatus::Outdated);
    }

    #[tokio::test]
    async fn check_status_reports_node_unavailable() {
        let env = build_env_with(
            FixedNodeResolver::unavailable(),
            FixedSignatureVerifier::passing(),
        );
        let info = env
            .manager
            .check_status(Provider::ClaudeCode)
            .await
            .unwrap();
        assert_eq!(info.status, RuntimeStatus::NodeUnavailable);
    }

    // ===== 并发互斥测试 =====

    /// 门控下载器：在下载前通知测试线程（表示锁已获取），然后等待门控释放。
    struct GatedPackDownloader {
        started_tx: mpsc::UnboundedSender<()>,
        gate: Arc<Notify>,
    }

    #[async_trait]
    impl PackDownloader for GatedPackDownloader {
        async fn download(
            &self,
            _manifest: &RuntimeManifest,
            _progress: Box<dyn ProgressReporter>,
        ) -> Result<PathBuf, RuntimeError> {
            let _ = self.started_tx.send(());
            self.gate.notified().await;
            // 释放后写入一个 dummy pack
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| RuntimeError::io_failed(None, format!("无法创建临时文件: {}", e)))?;
            std::fs::write(tmp.path(), b"pack")
                .map_err(|e| RuntimeError::io_failed(None, format!("无法写入临时文件: {}", e)))?;
            let (_file, path) = tmp
                .keep()
                .map_err(|e| RuntimeError::io_failed(None, format!("{}", e)))?;
            Ok(path)
        }
    }

    #[tokio::test]
    async fn concurrent_install_same_provider_returns_busy() {
        let manifest_source = Arc::new(InMemoryManifestSource::new());
        let archive_extractor = Arc::new(InMemoryArchiveExtractor::new());
        let fs = Arc::new(TempRuntimeFileSystem::new());

        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let gate = Arc::new(Notify::new());
        let pack_downloader = Arc::new(GatedPackDownloader {
            started_tx,
            gate: gate.clone(),
        });

        let pack_tmp = tempfile::TempDir::new().unwrap();
        archive_extractor.register_default_source(create_pack_source_dir(pack_tmp.path()));

        let manifest = sample_manifest(Provider::ClaudeCode, "0.3.170");
        manifest_source.register(manifest);

        let manager = Arc::new(
            RuntimeManager::new(
                manifest_source,
                pack_downloader,
                Arc::new(FixedSignatureVerifier::passing()),
                archive_extractor,
                Arc::new(FixedNodeResolver::satisfied()),
                fs,
                "0.2.0",
            )
            .with_target(Platform::Windows, Arch::X64),
        );

        // 启动第一个安装（会阻塞在下载步骤）
        let m1 = manager.clone();
        let first = tokio::spawn(async move { m1.install(Provider::ClaudeCode, None).await });

        // 等待第一个任务到达下载步骤（表示锁已获取）
        started_rx.recv().await.unwrap();

        // 第二个安装同一 provider → 应返回 Busy
        let err = manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RuntimeErrorKind::Busy);

        // 释放门控，让第一个安装完成
        gate.notify_one();
        let outcome = first.await.unwrap().unwrap();
        assert_eq!(outcome.installed_version, "0.3.170");
    }

    #[tokio::test]
    async fn concurrent_install_different_providers_succeed() {
        let manifest_source = Arc::new(InMemoryManifestSource::new());
        let pack_downloader = Arc::new(InMemoryPackDownloader::new());
        let archive_extractor = Arc::new(InMemoryArchiveExtractor::new());
        let fs = Arc::new(TempRuntimeFileSystem::new());

        let pack_tmp = tempfile::TempDir::new().unwrap();
        archive_extractor.register_default_source(create_pack_source_dir(pack_tmp.path()));

        // 注册两个 provider 的 manifest 和 pack
        for provider in [Provider::ClaudeCode, Provider::Codex] {
            let m = sample_manifest(provider, "1.0.0");
            manifest_source.register(m.clone());
            pack_downloader.register_pack(m.asset.url.clone(), vec![1, 2]);
        }

        let manager = RuntimeManager::new(
            manifest_source,
            pack_downloader,
            Arc::new(FixedSignatureVerifier::passing()),
            archive_extractor,
            Arc::new(FixedNodeResolver::satisfied()),
            fs.clone(),
            "0.2.0",
        )
        .with_target(Platform::Windows, Arch::X64);

        // 并发安装两个不同 provider → 都应成功
        let manager = Arc::new(manager);
        let m_claude = manager.clone();
        let m_codex = manager.clone();

        let (r1, r2) = tokio::join!(
            async { m_claude.install(Provider::ClaudeCode, None).await },
            async { m_codex.install(Provider::Codex, None).await },
        );

        r1.unwrap();
        r2.unwrap();
        assert_eq!(
            fs.read_current_version(Provider::ClaudeCode),
            Some("1.0.0".to_string())
        );
        assert_eq!(
            fs.read_current_version(Provider::Codex),
            Some("1.0.0".to_string())
        );
    }

    // ===== 版本安全测试 =====

    #[tokio::test]
    async fn install_new_version_preserves_old_version_files() {
        let env = build_env();
        // 注册并安装旧版本
        let old = sample_manifest(Provider::ClaudeCode, "0.3.169");
        env.manifest_source.register(old.clone());
        env.pack_downloader
            .register_pack(old.asset.url.clone(), vec![5, 6]);
        env.manager
            .install_version(Provider::ClaudeCode, "0.3.169", None)
            .await
            .unwrap();

        let old_dir = env.fs.version_dir(Provider::ClaudeCode, "0.3.169");
        let old_file_content = std::fs::read_to_string(old_dir.join("package.json")).unwrap();

        // 安装新版本
        env.manager
            .install(Provider::ClaudeCode, None)
            .await
            .unwrap();

        // 旧版本目录和文件应保持不变
        assert!(old_dir.exists(), "旧版本目录应保留");
        assert_eq!(
            std::fs::read_to_string(old_dir.join("package.json")).unwrap(),
            old_file_content,
            "旧版本文件内容不应被修改"
        );
        assert_eq!(
            env.fs.read_current_version(Provider::ClaudeCode),
            Some("0.3.170".to_string())
        );
    }
}
