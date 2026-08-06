//! Runtime 领域的生产实现：`ArchiveExtractor`、`NodeResolver`、`HttpPackDownloader`。
//!
//! 这些结构实现 `seam` 中的 trait，提供真实环境下的 tar.gz 解压、Node.js 检测和
//! GitHub Release 资产下载。Runtime Manager 通过依赖 trait 在测试中替换为内存夹具。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use async_trait::async_trait;
use flate2::read::GzDecoder;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::error::RuntimeError;
use super::manifest::RuntimeManifest;
use super::seam::{
    ArchiveExtractor, ManifestSource, NodeResolver, PackDownloader, ProgressReporter,
};
use super::signing::hex_encode;
use super::types::{Arch, InstallStage, NodeDetection, Platform, Progress, Provider};

/// 生产归档解压器。使用 `tar` + `flate2` 解压 `.tar.gz` Runtime Pack。
pub struct TarGzArchiveExtractor;

impl TarGzArchiveExtractor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TarGzArchiveExtractor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ArchiveExtractor for TarGzArchiveExtractor {
    async fn extract(&self, archive_path: &Path, dest_dir: &Path) -> Result<(), RuntimeError> {
        let archive_path = archive_path.to_path_buf();
        let dest_dir = dest_dir.to_path_buf();
        // 解压是 CPU + IO 密集型，放到阻塞线程池执行。
        tokio::task::spawn_blocking(move || -> Result<(), RuntimeError> {
            extract_targz_blocking(&archive_path, &dest_dir)
        })
        .await
        .map_err(|e| RuntimeError::extract_failed(None, format!("解压任务 join 失败: {}", e)))??;
        Ok(())
    }
}

fn extract_targz_blocking(archive_path: &Path, dest_dir: &Path) -> Result<(), RuntimeError> {
    let file = std::fs::File::open(archive_path).map_err(|e| {
        RuntimeError::extract_failed(
            None,
            format!("无法打开归档文件 {}: {}", archive_path.display(), e),
        )
    })?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    std::fs::create_dir_all(dest_dir).map_err(|e| {
        RuntimeError::extract_failed(
            None,
            format!("无法创建目标目录 {}: {}", dest_dir.display(), e),
        )
    })?;
    archive.unpack(dest_dir).map_err(|e| {
        RuntimeError::extract_failed(
            None,
            format!(
                "解压归档 {} 到 {} 失败: {}",
                archive_path.display(),
                dest_dir.display(),
                e
            ),
        )
    })
}

/// 生产 Node.js 解析器。通过 `node --version` 和 `which`/`where` 检测 PATH 中的 node。
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

#[async_trait]
impl NodeResolver for SystemNodeResolver {
    async fn detect(&self) -> NodeDetection {
        let node_path = match find_node_in_path() {
            Some(path) => path,
            None => {
                return NodeDetection::unavailable("PATH 中未找到 node 可执行文件");
            }
        };

        let version = match query_node_version(&node_path) {
            Ok(v) => v,
            Err(message) => {
                return NodeDetection::unavailable(format!(
                    "无法解析 node 版本（{}）：{}",
                    node_path.display(),
                    message
                ));
            }
        };

        NodeDetection::from_version(version, node_path.to_str().map(|s| s.to_string()))
    }
}

/// 在 PATH 中查找 `node` 可执行文件路径。
fn find_node_in_path() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let which_cmd = if cfg!(windows) { "where" } else { "which" };

    let output = Command::new(which_cmd).arg(executable).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next()?.trim();
    if first_line.is_empty() {
        None
    } else {
        Some(PathBuf::from(first_line))
    }
}

/// 执行 `node --version` 并返回版本字符串（如 `v20.10.0`）。
fn query_node_version(node_path: &Path) -> Result<Option<String>, String> {
    let output = Command::new(node_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("执行失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "退出码非零: {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout.trim().to_string();
    if version.is_empty() {
        Ok(None)
    } else {
        Ok(Some(version))
    }
}

/// 生产 Pack 下载器。使用 `reqwest` 流式下载 GitHub Release 资产到临时文件，
/// 并通过 `ProgressReporter` 汇报下载进度。
///
/// 下载完成后返回临时文件路径；调用方负责在校验、解压完成后清理。
pub struct HttpPackDownloader {
    client: reqwest::Client,
    /// 下载互斥：按 URL 串行化，避免同一资产并发下载。
    /// 同一 Provider 的并发安装已由 RuntimeManager 的 per-provider mutex 保护，
    /// 这里额外加锁仅为防御性设计。
    download_lock: Mutex<()>,
}

impl HttpPackDownloader {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            download_lock: Mutex::new(()),
        }
    }

    /// 使用默认 `reqwest::Client` 创建。
    pub fn with_default_client() -> Self {
        Self::new(reqwest::Client::new())
    }
}

#[async_trait]
impl PackDownloader for HttpPackDownloader {
    async fn download(
        &self,
        manifest: &RuntimeManifest,
        progress: Box<dyn ProgressReporter>,
    ) -> Result<PathBuf, RuntimeError> {
        let _guard = self.download_lock.lock().await;

        let provider = manifest.provider;
        let url = manifest.asset.url.clone();
        let expected_size = manifest.asset.size_bytes;
        let expected_sha256 = manifest.asset.sha256.to_lowercase();

        progress
            .report(
                Progress::new(InstallStage::Downloading)
                    .with_bytes(0, expected_size)
                    .with_message(format!("正在下载 {} Runtime Pack", provider.label())),
            )
            .await;

        let response = self.client.get(&url).send().await.map_err(|e| {
            RuntimeError::download_failed(Some(provider), format!("请求 {} 失败: {}", url, e))
        })?;

        if !response.status().is_success() {
            return Err(RuntimeError::download_failed(
                Some(provider),
                format!("{} 返回非成功状态码: {}", url, response.status()),
            ));
        }

        let actual_size = response.content_length().unwrap_or(expected_size);

        // 创建临时文件
        let temp_file = tempfile::NamedTempFile::new().map_err(|e| {
            RuntimeError::io_failed(Some(provider), format!("无法创建临时文件: {}", e))
        })?;

        // 流式写入并计算 SHA-256
        let mut file = tokio::fs::File::from_std(temp_file.reopen().map_err(|e| {
            RuntimeError::io_failed(Some(provider), format!("无法重开临时文件: {}", e))
        })?);
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut bytes_done: u64 = 0;
        let mut last_reported_percent: u8 = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| {
                RuntimeError::download_failed(Some(provider), format!("读取响应流失败: {}", e))
            })?;
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| {
                RuntimeError::io_failed(Some(provider), format!("写入临时文件失败: {}", e))
            })?;
            bytes_done += chunk.len() as u64;
            let percent = if actual_size > 0 {
                ((bytes_done as f64 / actual_size as f64) * 100.0) as u8
            } else {
                0
            };
            // 节流：仅在百分比变化 >= 5 时汇报，避免淹没进度通道。
            if percent >= last_reported_percent + 5 || percent >= 100 {
                progress
                    .report(
                        Progress::new(InstallStage::Downloading)
                            .with_bytes(bytes_done, actual_size),
                    )
                    .await;
                last_reported_percent = percent;
            }
        }

        // flush & sync 确保落盘
        file.flush().await.map_err(|e| {
            RuntimeError::io_failed(Some(provider), format!("flush 临时文件失败: {}", e))
        })?;
        drop(file);

        // 校验下载字节数（若服务端报告了 content-length）
        if actual_size == expected_size && bytes_done != expected_size {
            return Err(RuntimeError::download_failed(
                Some(provider),
                format!(
                    "下载字节数不匹配：期望 {}，实际 {}",
                    expected_size, bytes_done
                ),
            ));
        }

        // 校验 SHA-256
        let actual_sha256 = hex_encode(&hasher.finalize());
        if actual_sha256 != expected_sha256 {
            return Err(RuntimeError::hash_mismatch(
                Some(provider),
                format!(
                    "下载内容 SHA-256 不匹配：期望 {}，实际 {}",
                    expected_sha256, actual_sha256
                ),
            ));
        }

        progress
            .report(
                Progress::new(InstallStage::Downloading)
                    .with_bytes(bytes_done, actual_size)
                    .with_percent(100)
                    .with_message("下载完成"),
            )
            .await;

        // 将临时文件持久化到固定路径，避免 NamedTempFile drop 时自动删除
        let (_file, persisted_path) = temp_file.keep().map_err(|e| {
            RuntimeError::io_failed(Some(provider), format!("无法保留临时文件: {}", e))
        })?;
        Ok(persisted_path)
    }
}

/// GitHub Release manifest 源。
///
/// 从 GitHub Releases 拉取 Runtime manifest。manifest 以 release asset 形式发布：
/// - Release tag 命名：`runtime-{provider}-{version}`（例如 `runtime-claude_code-0.3.170`）
/// - Manifest asset 命名：`{provider}-{version}-{platform}-{arch}.manifest.json`
///
/// `fetch_latest` 通过 GitHub Releases API 列出所有 release，过滤 tag 前缀并选取最高语义化版本。
/// `fetch_version` 直接构造 manifest URL 下载。
pub struct GitHubReleaseManifestSource {
    client: reqwest::Client,
    /// GitHub 仓库标识，例如 `kfumi/codeMUX`。
    repo: String,
    /// 自定义 manifest 基础 URL 模板（测试用）。
    /// 占位符：`{repo}`、`{tag}`、`{asset}`。
    /// 为 `None` 时使用默认 GitHub Release 下载 URL。
    manifest_url_template: Option<String>,
}

impl GitHubReleaseManifestSource {
    /// 使用默认 GitHub repo 创建。
    pub fn new(repo: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("codemux-runtime-manager")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            repo: repo.into(),
            manifest_url_template: None,
        }
    }

    /// 使用 CodeMUX 默认仓库 `kfumi/codeMUX` 创建。
    pub fn default_repo() -> Self {
        Self::new("kfumi/codeMUX")
    }

    /// 覆盖 manifest URL 模板（测试用）。
    pub fn with_manifest_url_template(mut self, template: impl Into<String>) -> Self {
        self.manifest_url_template = Some(template.into());
        self
    }

    /// 构造指定 Provider、版本、平台、架构的 manifest asset 文件名。
    fn manifest_asset_name(
        provider: Provider,
        version: &str,
        platform: Platform,
        arch: Arch,
    ) -> String {
        format!(
            "{}-{}-{}-{}.manifest.json",
            provider.as_str(),
            version,
            platform.as_str(),
            arch.as_str()
        )
    }

    /// 构造 manifest 下载 URL。
    fn manifest_url(&self, tag: &str, asset: &str) -> String {
        if let Some(template) = &self.manifest_url_template {
            return template
                .replace("{repo}", &self.repo)
                .replace("{tag}", tag)
                .replace("{asset}", asset);
        }
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.repo, tag, asset
        )
    }

    /// 通过 GitHub Releases API 列出所有 release tag。
    async fn list_release_tags(&self) -> Result<Vec<String>, RuntimeError> {
        let url = format!(
            "https://api.github.com/repos/{}/releases?per_page=100",
            self.repo
        );
        let response = self.client.get(&url).send().await.map_err(|e| {
            RuntimeError::manifest_failed(None, format!("请求 GitHub Releases API 失败: {}", e))
        })?;
        if !response.status().is_success() {
            return Err(RuntimeError::manifest_failed(
                None,
                format!(
                    "GitHub Releases API 返回非成功状态码: {}",
                    response.status()
                ),
            ));
        }
        let releases: Vec<serde_json::Value> = response.json().await.map_err(|e| {
            RuntimeError::manifest_failed(None, format!("解析 GitHub Releases 响应失败: {}", e))
        })?;
        Ok(releases
            .into_iter()
            .filter_map(|r| r.get("tag_name").and_then(|t| t.as_str()).map(String::from))
            .collect())
    }
}

#[async_trait]
impl ManifestSource for GitHubReleaseManifestSource {
    async fn fetch_latest(
        &self,
        provider: Provider,
        platform: Platform,
        arch: Arch,
    ) -> Result<RuntimeManifest, RuntimeError> {
        let tag_prefix = format!("runtime-{}-", provider.as_str());
        let tags = self.list_release_tags().await?;
        let mut candidates: Vec<(String, super::types::SemverVersion)> = Vec::new();
        for tag in tags {
            if let Some(version_str) = tag.strip_prefix(&tag_prefix) {
                if let Some(semver) = super::types::SemverVersion::parse(version_str) {
                    candidates.push((tag, semver));
                }
            }
        }
        if candidates.is_empty() {
            return Err(RuntimeError::manifest_failed(
                Some(provider),
                format!(
                    "未找到 {} 的 Runtime Release（tag 前缀 {}）",
                    provider.label(),
                    tag_prefix
                ),
            ));
        }
        // 选取最高语义化版本
        candidates.sort_by_key(|(_, v)| std::cmp::Reverse((v.major, v.minor, v.patch)));
        let (latest_tag, latest_version) = candidates.into_iter().next().unwrap();
        let asset = Self::manifest_asset_name(provider, &latest_version.raw, platform, arch);
        let url = self.manifest_url(&latest_tag, &asset);
        fetch_manifest_from_url(&self.client, &url, Some(provider)).await
    }

    async fn list_versions(
        &self,
        provider: Provider,
        _platform: Platform,
        _arch: Arch,
    ) -> Result<Vec<String>, RuntimeError> {
        let tag_prefix = format!("runtime-{}-", provider.as_str());
        let tags = self.list_release_tags().await?;
        let mut versions: Vec<super::types::SemverVersion> = tags
            .into_iter()
            .filter_map(|tag| {
                tag.strip_prefix(&tag_prefix)
                    .and_then(super::types::SemverVersion::parse)
            })
            .collect();
        versions.sort_by_key(|v| std::cmp::Reverse((v.major, v.minor, v.patch)));
        Ok(versions.into_iter().map(|v| v.raw).collect())
    }

    async fn fetch_version(
        &self,
        provider: Provider,
        platform: Platform,
        arch: Arch,
        version: &str,
    ) -> Result<RuntimeManifest, RuntimeError> {
        let tag = format!("runtime-{}-{}", provider.as_str(), version);
        let asset = Self::manifest_asset_name(provider, version, platform, arch);
        let url = self.manifest_url(&tag, &asset);
        fetch_manifest_from_url(&self.client, &url, Some(provider)).await
    }
}

/// 从指定 URL 拉取并解析 manifest JSON。
async fn fetch_manifest_from_url(
    client: &reqwest::Client,
    url: &str,
    provider: Option<Provider>,
) -> Result<RuntimeManifest, RuntimeError> {
    let response = client.get(url).send().await.map_err(|e| {
        RuntimeError::manifest_failed(provider, format!("请求 manifest {} 失败: {}", url, e))
    })?;
    if !response.status().is_success() {
        return Err(RuntimeError::manifest_failed(
            provider,
            format!("manifest {} 返回非成功状态码: {}", url, response.status()),
        ));
    }
    let manifest: RuntimeManifest = response.json().await.map_err(|e| {
        RuntimeError::manifest_failed(provider, format!("解析 manifest JSON 失败: {}", e))
    })?;
    manifest.validate().map_err(|msg| {
        RuntimeError::manifest_failed(provider, format!("manifest 校验失败: {}", msg))
    })?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn targz_extractor_extracts_simple_archive() {
        let tmp = tempfile::TempDir::new().unwrap();
        let archive_path = tmp.path().join("pack.tar.gz");
        let staging = tmp.path().join("staging");
        std::fs::create_dir_all(staging.join("bin")).unwrap();
        std::fs::write(staging.join("package.json"), b"{}").unwrap();
        std::fs::write(staging.join("bin").join("agent"), b"binary").unwrap();

        // 打包 staging 目录到 tar.gz
        {
            let tar_file = std::fs::File::create(&archive_path).unwrap();
            let gz = flate2::write::GzEncoder::new(tar_file, flate2::Compression::default());
            let mut tar = tar::Builder::new(gz);
            tar.append_dir_all("pkg", &staging).unwrap();
            // 注意：这里以 pkg 为根，模拟真实 Pack 结构
            tar.finish().unwrap();
        }

        let dest = tmp.path().join("dest");
        let extractor = TarGzArchiveExtractor::new();
        extractor.extract(&archive_path, &dest).await.unwrap();

        // 解压后结构应为 dest/pkg/package.json 和 dest/pkg/bin/agent
        assert!(dest.join("pkg").join("package.json").exists());
        assert!(dest.join("pkg").join("bin").join("agent").exists());
    }

    #[tokio::test]
    async fn targz_extractor_fails_on_missing_archive() {
        let tmp = tempfile::TempDir::new().unwrap();
        let archive_path = tmp.path().join("missing.tar.gz");
        let dest = tmp.path().join("dest");
        let extractor = TarGzArchiveExtractor::new();
        let err = extractor.extract(&archive_path, &dest).await.unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::ExtractFailed);
    }

    #[tokio::test]
    async fn targz_extractor_fails_on_corrupt_archive() {
        let tmp = tempfile::TempDir::new().unwrap();
        let archive_path = tmp.path().join("corrupt.tar.gz");
        let mut file = std::fs::File::create(&archive_path).unwrap();
        file.write_all(b"not a valid gzip").unwrap();
        let dest = tmp.path().join("dest");
        let extractor = TarGzArchiveExtractor::new();
        let err = extractor.extract(&archive_path, &dest).await.unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::ExtractFailed);
    }

    #[test]
    fn find_node_in_path_returns_some_or_none_gracefully() {
        // 不对具体环境做断言，只确保函数不会 panic。
        let _ = find_node_in_path();
    }
}
