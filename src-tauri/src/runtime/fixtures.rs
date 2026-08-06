//! Runtime 领域的测试夹具。
//!
//! 提供 `ManifestSource`、`PackDownloader`、`SignatureVerifier` 的内存实现，
//! 以及基于 `tempfile` 的 `RuntimeFileSystem` 夹具。这些夹具让 Runtime Manager 的测试
//! 不依赖真实 GitHub Release、全局 CLI、真实用户目录或固定本地路径。
//!
//! 虽然命名为夹具，但本模块在生产构建中也可链接（`#[allow(dead_code)]`），
//! 供其他模块的 `#[cfg(test)]` 块复用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;

use super::error::RuntimeError;
use super::manifest::RuntimeManifest;
use super::seam::{
    ArchiveExtractor, CurrentVersionStore, ManifestSource, NodeResolver, PackDownloader,
    ProgressReporter, RuntimeFileSystem, SignatureVerifier,
};
use super::types::{Arch, NodeDetection, Platform, Provider};

/// 内存 manifest 源。按 `(provider, platform, arch)` 维度存储可用版本和 manifest。
///
/// 版本列表按插入顺序倒序返回（最后插入的是最新版）。
pub struct InMemoryManifestSource {
    inner: Mutex<InMemoryManifestInner>,
}

struct InMemoryManifestInner {
    /// key = `(provider, platform, arch)`，value = 有序版本列表（最新在前）。
    versions: HashMap<(Provider, Platform, Arch), Vec<String>>,
    /// key = `(provider, platform, arch, version)`。
    manifests: HashMap<(Provider, Platform, Arch, String), RuntimeManifest>,
    /// 是否在下次调用时返回错误，用于模拟网络故障。
    fail_next: Option<RuntimeError>,
}

impl InMemoryManifestSource {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InMemoryManifestInner {
                versions: HashMap::new(),
                manifests: HashMap::new(),
                fail_next: None,
            }),
        }
    }

    /// 注册一个 manifest。多次注册同版本会覆盖。
    /// 版本顺序由首次注册顺序决定；越晚注册的视为越新。
    pub fn register(&self, manifest: RuntimeManifest) {
        let mut inner = self.inner.lock().unwrap();
        let key = manifest.target();
        let versions = inner.versions.entry(key).or_default();
        if !versions.iter().any(|v| v == &manifest.version) {
            versions.push(manifest.version.clone());
        }
        // 保持最新版本在前。
        versions.sort_by(|a, b| b.cmp(a));
        inner.manifests.insert(
            (
                manifest.provider,
                manifest.platform,
                manifest.arch,
                manifest.version.clone(),
            ),
            manifest,
        );
    }

    /// 设置下次任意调用返回的错误，用于模拟 manifest 拉取失败。
    pub fn fail_next_with(&self, error: RuntimeError) {
        let mut inner = self.inner.lock().unwrap();
        inner.fail_next = Some(error);
    }

    fn take_failure(&self) -> Option<RuntimeError> {
        let mut inner = self.inner.lock().unwrap();
        inner.fail_next.take()
    }
}

impl Default for InMemoryManifestSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ManifestSource for InMemoryManifestSource {
    async fn fetch_latest(
        &self,
        provider: Provider,
        platform: Platform,
        arch: Arch,
    ) -> Result<RuntimeManifest, RuntimeError> {
        if let Some(err) = self.take_failure() {
            return Err(err);
        }
        let inner = self.inner.lock().unwrap();
        let versions = inner
            .versions
            .get(&(provider, platform, arch))
            .cloned()
            .unwrap_or_default();
        let latest = versions.first().ok_or_else(|| {
            RuntimeError::manifest_failed(
                Some(provider),
                format!("{} 没有可用版本", provider.label()),
            )
        })?;
        inner
            .manifests
            .get(&(provider, platform, arch, latest.clone()))
            .cloned()
            .ok_or_else(|| {
                RuntimeError::manifest_failed(
                    Some(provider),
                    format!("{} manifest 缺失: {}", provider.label(), latest),
                )
            })
    }

    async fn list_versions(
        &self,
        provider: Provider,
        platform: Platform,
        arch: Arch,
    ) -> Result<Vec<String>, RuntimeError> {
        if let Some(err) = self.take_failure() {
            return Err(err);
        }
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .versions
            .get(&(provider, platform, arch))
            .cloned()
            .unwrap_or_default())
    }

    async fn fetch_version(
        &self,
        provider: Provider,
        platform: Platform,
        arch: Arch,
        version: &str,
    ) -> Result<RuntimeManifest, RuntimeError> {
        if let Some(err) = self.take_failure() {
            return Err(err);
        }
        let inner = self.inner.lock().unwrap();
        inner
            .manifests
            .get(&(provider, platform, arch, version.to_string()))
            .cloned()
            .ok_or_else(|| {
                RuntimeError::manifest_failed(
                    Some(provider),
                    format!("{} 版本 {} manifest 缺失", provider.label(), version),
                )
            })
    }
}

/// 内存 Pack 下载器。按 manifest URL 返回预设字节，写入临时文件。
pub struct InMemoryPackDownloader {
    /// key = url，value = pack 字节内容。
    packs: Mutex<HashMap<String, Vec<u8>>>,
    /// 是否在下次调用时返回错误。
    fail_next: Mutex<Option<RuntimeError>>,
}

impl InMemoryPackDownloader {
    pub fn new() -> Self {
        Self {
            packs: Mutex::new(HashMap::new()),
            fail_next: Mutex::new(None),
        }
    }

    pub fn register_pack(&self, url: impl Into<String>, bytes: Vec<u8>) {
        self.packs.lock().unwrap().insert(url.into(), bytes);
    }

    pub fn fail_next_with(&self, error: RuntimeError) {
        *self.fail_next.lock().unwrap() = Some(error);
    }
}

impl Default for InMemoryPackDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PackDownloader for InMemoryPackDownloader {
    async fn download(
        &self,
        manifest: &RuntimeManifest,
        progress: Box<dyn ProgressReporter>,
    ) -> Result<PathBuf, RuntimeError> {
        if let Some(err) = self.fail_next.lock().unwrap().take() {
            return Err(err);
        }
        let bytes = {
            let packs = self.packs.lock().unwrap();
            packs.get(&manifest.asset.url).cloned().ok_or_else(|| {
                RuntimeError::download_failed(
                    Some(manifest.provider),
                    format!("未注册的 pack URL: {}", manifest.asset.url),
                )
            })?
        };
        let total = bytes.len() as u64;
        progress
            .report(
                super::types::Progress::new(super::types::InstallStage::Downloading)
                    .with_bytes(0, total),
            )
            .await;
        let tmp = tempfile::NamedTempFile::new().map_err(|e| {
            RuntimeError::io_failed(Some(manifest.provider), format!("无法创建临时文件: {}", e))
        })?;
        std::fs::write(tmp.path(), &bytes).map_err(|e| {
            RuntimeError::io_failed(Some(manifest.provider), format!("无法写入临时文件: {}", e))
        })?;
        progress
            .report(
                super::types::Progress::new(super::types::InstallStage::Downloading)
                    .with_bytes(total, total)
                    .with_percent(100),
            )
            .await;
        // keep the temp file by persisting it to a path under tmp dir
        let (_file, path) = tmp.keep().map_err(|e| {
            RuntimeError::io_failed(Some(manifest.provider), format!("无法保留临时文件: {}", e))
        })?;
        Ok(path)
    }
}

/// 固定签名校验器。默认通过；可配置为总是失败或返回指定错误。
pub struct FixedSignatureVerifier {
    error: Option<RuntimeError>,
}

impl FixedSignatureVerifier {
    pub fn passing() -> Self {
        Self { error: None }
    }

    pub fn failing() -> Self {
        Self {
            error: Some(RuntimeError::signature_error(
                None,
                "签名校验失败（夹具配置为失败）".to_string(),
            )),
        }
    }

    /// 返回指定错误（用于测试 hash_mismatch 等不同错误类型）。
    pub fn failing_with(error: RuntimeError) -> Self {
        Self { error: Some(error) }
    }
}

#[async_trait]
impl SignatureVerifier for FixedSignatureVerifier {
    async fn verify(
        &self,
        manifest: &RuntimeManifest,
        _pack_path: &Path,
    ) -> Result<(), RuntimeError> {
        if let Some(ref err) = self.error {
            let mut err = err.clone();
            err.provider = Some(manifest.provider);
            return Err(err);
        }
        Ok(())
    }
}

/// 基于临时目录的 `RuntimeFileSystem` 夹具。
///
/// 包装 `FileSystemRuntimeRoots`，让每个测试获得独立的临时 Runtime 根目录。
pub struct TempRuntimeFileSystem {
    _tmp: tempfile::TempDir,
    roots: super::seam::FileSystemRuntimeRoots,
}

impl TempRuntimeFileSystem {
    pub fn new() -> Self {
        let tmp = tempfile::TempDir::new().expect("无法创建临时目录");
        let roots = super::seam::FileSystemRuntimeRoots::new(tmp.path().to_path_buf());
        Self { _tmp: tmp, roots }
    }

    pub fn root_path(&self) -> &Path {
        self.roots.root()
    }
}

impl Default for TempRuntimeFileSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeFileSystem for TempRuntimeFileSystem {
    fn root(&self) -> PathBuf {
        self.roots.root().to_path_buf()
    }
    fn read_current_version(&self, provider: Provider) -> Option<String> {
        self.roots.read_current_version(provider)
    }
    fn write_current_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        self.roots.write_current_version(provider, version)
    }
    fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
        self.roots.list_installed_versions(provider)
    }
    fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        self.roots.remove_version(provider, version)
    }
    fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError> {
        self.roots.remove_provider(provider)
    }
}

/// 内存当前版本指针存储，用于不依赖文件系统的单元测试。
pub struct InMemoryCurrentVersionStore {
    map: Mutex<HashMap<Provider, String>>,
}

impl InMemoryCurrentVersionStore {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryCurrentVersionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CurrentVersionStore for InMemoryCurrentVersionStore {
    fn read(&self, provider: Provider) -> Option<String> {
        self.map.lock().unwrap().get(&provider).cloned()
    }
    fn write(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        self.map
            .lock()
            .unwrap()
            .insert(provider, version.to_string());
        Ok(())
    }
    fn clear(&self, provider: Provider) -> Result<(), RuntimeError> {
        self.map.lock().unwrap().remove(&provider);
        Ok(())
    }
}

/// 内存归档解压器。注册 `(archive_path -> 预暂存目录)` 后，调用 `extract` 时直接复制
/// 预暂存目录内容到目标目录。用于绕过真实 tar.gz 解压，让 Runtime Manager 测试聚焦于
/// 生命周期编排而非归档格式。
///
/// 也可注册 `fail_next` 模拟解压失败。注册 `default_source` 后，未匹配的 archive_path
/// 将使用默认源目录（因为下载器返回的临时路径不可预知）。
pub struct InMemoryArchiveExtractor {
    /// key = archive_path 字符串形式，value = 预暂存源目录。
    sources: Mutex<HashMap<String, PathBuf>>,
    /// 未匹配 archive_path 时使用的默认源目录。
    default_source: Mutex<Option<PathBuf>>,
    fail_next: Mutex<Option<RuntimeError>>,
}

impl InMemoryArchiveExtractor {
    pub fn new() -> Self {
        Self {
            sources: Mutex::new(HashMap::new()),
            default_source: Mutex::new(None),
            fail_next: Mutex::new(None),
        }
    }

    /// 注册 `archive_path` 对应的预暂存源目录。`extract` 调用时递归复制该目录。
    pub fn register_source(&self, archive_path: impl Into<String>, source_dir: PathBuf) {
        self.sources
            .lock()
            .unwrap()
            .insert(archive_path.into(), source_dir);
    }

    /// 注册默认源目录。当 `extract` 收到的 archive_path 未注册时使用此目录。
    /// 用于 Runtime Manager 生命周期测试——下载器返回的临时路径不可预知，
    /// 测试无法提前注册具体路径。
    pub fn register_default_source(&self, source_dir: PathBuf) {
        *self.default_source.lock().unwrap() = Some(source_dir);
    }

    pub fn fail_next_with(&self, error: RuntimeError) {
        *self.fail_next.lock().unwrap() = Some(error);
    }
}

impl Default for InMemoryArchiveExtractor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ArchiveExtractor for InMemoryArchiveExtractor {
    async fn extract(&self, archive_path: &Path, dest_dir: &Path) -> Result<(), RuntimeError> {
        if let Some(err) = self.fail_next.lock().unwrap().take() {
            return Err(err);
        }
        let source = {
            let sources = self.sources.lock().unwrap();
            sources
                .get(&archive_path.to_string_lossy().to_string())
                .cloned()
                .or_else(|| self.default_source.lock().unwrap().clone())
                .ok_or_else(|| {
                    RuntimeError::extract_failed(
                        None,
                        format!("未注册的归档路径: {}", archive_path.display()),
                    )
                })?
        };
        copy_dir_recursive(&source, dest_dir).map_err(|e| {
            RuntimeError::extract_failed(
                None,
                format!(
                    "复制预暂存目录 {} 到 {} 失败: {}",
                    source.display(),
                    dest_dir.display(),
                    e
                ),
            )
        })
    }
}

/// 递归复制目录。测试夹具内部使用。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let dest_child = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&path, &dest_child)?;
        } else if file_type.is_file() {
            std::fs::copy(&path, &dest_child)?;
        }
    }
    Ok(())
}

/// 固定 Node.js 解析器夹具。返回预设的 `NodeDetection`，让 Runtime Manager 测试
/// 不依赖真实 PATH。
pub struct FixedNodeResolver {
    detection: NodeDetection,
}

impl FixedNodeResolver {
    pub fn new(detection: NodeDetection) -> Self {
        Self { detection }
    }

    /// 返回满足 Node 18+ 的检测结果。
    pub fn satisfied() -> Self {
        Self::new(NodeDetection::from_version(
            Some("v20.10.0".to_string()),
            Some("/usr/bin/node".to_string()),
        ))
    }

    /// 返回 Node 不可用的检测结果（用于测试 Node 缺失）。
    pub fn unavailable() -> Self {
        Self::new(NodeDetection::unavailable("node not found in PATH"))
    }

    /// 返回 Node 版本过低的检测结果（用于测试 Node < 18）。
    pub fn too_old() -> Self {
        Self::new(NodeDetection::from_version(
            Some("v16.20.0".to_string()),
            Some("/usr/bin/node".to_string()),
        ))
    }
}

#[async_trait]
impl NodeResolver for FixedNodeResolver {
    async fn detect(&self) -> NodeDetection {
        self.detection.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::manifest::RuntimeManifestAsset;
    use crate::runtime::types::InstallStage;

    fn sample_manifest(provider: Provider, version: &str) -> RuntimeManifest {
        RuntimeManifest {
            schema_version: crate::runtime::manifest::MANIFEST_SCHEMA_VERSION,
            provider,
            version: version.to_string(),
            platform: Platform::Windows,
            arch: Arch::X64,
            asset: RuntimeManifestAsset {
                url: format!("https://example.com/{}-{}.zip", provider.as_str(), version),
                size_bytes: 1024,
                sha256: "a".repeat(64),
                signature: "sig".to_string(),
            },
            sidecar_compat: ">=0.2.0".to_string(),
            key_files: vec!["package.json".to_string()],
            key_binaries: vec!["bin/agent.exe".to_string()],
            created_at: "2026-08-05T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn in_memory_manifest_source_lists_and_fetches() {
        let source = InMemoryManifestSource::new();
        source.register(sample_manifest(Provider::ClaudeCode, "0.3.169"));
        source.register(sample_manifest(Provider::ClaudeCode, "0.3.170"));

        let versions = source
            .list_versions(Provider::ClaudeCode, Platform::Windows, Arch::X64)
            .await
            .unwrap();
        assert_eq!(versions, vec!["0.3.170".to_string(), "0.3.169".to_string()]);

        let latest = source
            .fetch_latest(Provider::ClaudeCode, Platform::Windows, Arch::X64)
            .await
            .unwrap();
        assert_eq!(latest.version, "0.3.170");

        let specific = source
            .fetch_version(
                Provider::ClaudeCode,
                Platform::Windows,
                Arch::X64,
                "0.3.169",
            )
            .await
            .unwrap();
        assert_eq!(specific.version, "0.3.169");
    }

    #[tokio::test]
    async fn in_memory_manifest_source_returns_error_when_empty() {
        let source = InMemoryManifestSource::new();
        let err = source
            .fetch_latest(Provider::Codex, Platform::Windows, Arch::X64)
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::ManifestFailed);
    }

    #[tokio::test]
    async fn in_memory_manifest_source_fail_next_simulates_network_error() {
        let source = InMemoryManifestSource::new();
        source.register(sample_manifest(Provider::OpenCode, "1.18.3"));
        source.fail_next_with(RuntimeError::download_failed(
            Some(Provider::OpenCode),
            "simulated 503",
        ));
        let err = source
            .fetch_latest(Provider::OpenCode, Platform::Windows, Arch::X64)
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::DownloadFailed);
        // 失败只消费一次
        let ok = source
            .fetch_latest(Provider::OpenCode, Platform::Windows, Arch::X64)
            .await
            .unwrap();
        assert_eq!(ok.version, "1.18.3");
    }

    #[tokio::test]
    async fn in_memory_pack_downloader_writes_registered_bytes() {
        let downloader = InMemoryPackDownloader::new();
        let manifest = sample_manifest(Provider::ClaudeCode, "0.3.169");
        downloader.register_pack(manifest.asset.url.clone(), vec![1, 2, 3, 4]);

        let (reporter, mut rx) =
            crate::runtime::seam::test_progress::ChannelProgressReporter::new();
        let path = downloader
            .download(&manifest, Box::new(reporter))
            .await
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4]);

        // 收到进度汇报
        let first = rx.recv().await.unwrap();
        assert_eq!(first.stage, InstallStage::Downloading);
        assert_eq!(first.bytes_total, Some(4));
    }

    #[tokio::test]
    async fn in_memory_pack_downloader_fails_for_unregistered_url() {
        let downloader = InMemoryPackDownloader::new();
        let manifest = sample_manifest(Provider::Codex, "0.139.0");
        let err = downloader
            .download(
                &manifest,
                Box::new(crate::runtime::seam::NoopProgressReporter),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::DownloadFailed);
    }

    #[tokio::test]
    async fn fixed_signature_verifier_pass_or_fail() {
        let manifest = sample_manifest(Provider::OpenCode, "1.18.3");
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"bytes").unwrap();

        FixedSignatureVerifier::passing()
            .verify(&manifest, tmp.path())
            .await
            .unwrap();

        let err = FixedSignatureVerifier::failing()
            .verify(&manifest, tmp.path())
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::SignatureError);
    }

    #[test]
    fn temp_runtime_file_system_isolates_each_test() {
        let fs_a = TempRuntimeFileSystem::new();
        let fs_b = TempRuntimeFileSystem::new();
        fs_a.write_current_version(Provider::ClaudeCode, "0.3.169")
            .unwrap();
        assert_eq!(
            fs_a.read_current_version(Provider::ClaudeCode),
            Some("0.3.169".to_string())
        );
        assert_eq!(fs_b.read_current_version(Provider::ClaudeCode), None);
    }

    #[test]
    fn in_memory_current_version_store_round_trip() {
        let store = InMemoryCurrentVersionStore::new();
        assert_eq!(store.read(Provider::Codex), None);
        store.write(Provider::Codex, "0.139.0").unwrap();
        assert_eq!(store.read(Provider::Codex), Some("0.139.0".to_string()));
        store.clear(Provider::Codex).unwrap();
        assert_eq!(store.read(Provider::Codex), None);
    }

    #[tokio::test]
    async fn in_memory_archive_extractor_copies_registered_source() {
        let extractor = InMemoryArchiveExtractor::new();
        let tmp = tempfile::TempDir::new().unwrap();
        // 预暂存源目录
        let source_dir = tmp.path().join("source");
        std::fs::create_dir_all(source_dir.join("bin")).unwrap();
        std::fs::write(source_dir.join("package.json"), b"{}").unwrap();
        std::fs::write(source_dir.join("bin").join("agent.exe"), b"binary").unwrap();

        // 模拟归档路径
        let archive_path = tmp.path().join("fake-pack.tar.gz");
        std::fs::write(&archive_path, b"fake-archive").unwrap();
        extractor.register_source(
            archive_path.to_string_lossy().to_string(),
            source_dir.clone(),
        );

        // 解压到目标目录
        let dest_dir = tmp.path().join("dest");
        extractor.extract(&archive_path, &dest_dir).await.unwrap();

        assert!(dest_dir.join("package.json").exists());
        assert!(dest_dir.join("bin").join("agent.exe").exists());
    }

    #[tokio::test]
    async fn in_memory_archive_extractor_fails_when_unregistered() {
        let extractor = InMemoryArchiveExtractor::new();
        let tmp = tempfile::TempDir::new().unwrap();
        let archive_path = tmp.path().join("unknown.tar.gz");
        let dest_dir = tmp.path().join("dest");
        let err = extractor
            .extract(&archive_path, &dest_dir)
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::ExtractFailed);
    }

    #[tokio::test]
    async fn in_memory_archive_extractor_fail_next_simulates_error() {
        let extractor = InMemoryArchiveExtractor::new();
        extractor.fail_next_with(RuntimeError::extract_failed(
            Some(Provider::ClaudeCode),
            "simulated disk full",
        ));
        let tmp = tempfile::TempDir::new().unwrap();
        let archive_path = tmp.path().join("pack.tar.gz");
        let dest_dir = tmp.path().join("dest");
        let err = extractor
            .extract(&archive_path, &dest_dir)
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::ExtractFailed);
    }

    #[tokio::test]
    async fn fixed_node_resolver_returns_preset_detection() {
        let ok = FixedNodeResolver::satisfied();
        let detection = ok.detect().await;
        assert!(detection.available);
        assert!(detection.satisfies_minimum);

        let missing = FixedNodeResolver::unavailable();
        let detection = missing.detect().await;
        assert!(!detection.available);

        let old = FixedNodeResolver::too_old();
        let detection = old.detect().await;
        assert!(detection.available);
        assert!(!detection.satisfies_minimum);
    }
}
