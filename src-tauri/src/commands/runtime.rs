//! Runtime 管理 Tauri 命令。
//!
//! 提供统一的 Runtime 检测、安装、升级、修复、删除和重新检测入口，
//! 与外部 CLI 诊断（`agent_runtime_check`）完全分离。
//!
//! 前端通过这些命令管理 CodeMUX 自有 Runtime，不依赖 PATH 中的全局 CLI。

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::runtime::infra::{
    GitHubReleaseManifestSource, HttpPackDownloader, SystemNodeResolver, TarGzArchiveExtractor,
};
use crate::runtime::manager::RuntimeManager;
use crate::runtime::seam::{NodeResolver, ProgressReporter};
use crate::runtime::signing::Ed25519SignatureVerifier;
use crate::runtime::types::{Provider, RuntimeStatus};
use crate::AppState;

/// 单个 Provider 的 Runtime 检测结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeInfo {
    /// Provider 标识（claude_code / codex / opencode）。
    pub provider: String,
    /// 展示名。
    pub label: String,
    /// Runtime 状态。
    pub status: RuntimeStatus,
    /// 当前已安装版本。
    pub current_version: Option<String>,
    /// 所有已安装版本。
    pub installed_versions: Vec<String>,
    /// 安装路径（当前版本目录）。
    pub install_path: Option<String>,
    /// Runtime 根目录。
    pub runtime_root: String,
    /// 完整性检查结果。
    pub integrity_ok: bool,
    /// 面向用户的状态描述。
    pub message: String,
}

/// Node.js 检测信息。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub available: bool,
    pub satisfies_minimum: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub error: Option<String>,
}

/// 全部 Runtime 检测结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeCheckResult {
    pub checked_at: String,
    pub node: NodeInfo,
    pub runtimes: Vec<ManagedRuntimeInfo>,
}

/// 安装 / 升级 / 修复操作的结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeOperationResult {
    pub provider: String,
    pub label: String,
    /// 之前安装的版本（`None` 表示首次安装）。
    pub previous_version: Option<String>,
    /// 新安装的版本。
    pub installed_version: String,
    /// 安装目录绝对路径。
    pub install_path: String,
    /// 是否发生了实际版本切换。
    pub switched: bool,
}

/// 通过 Tauri 事件向前端汇报 Runtime 安装进度。
///
/// 事件名：`runtime-install-progress`，payload 为 `Progress`。
pub struct TauriProgressReporter {
    app: AppHandle,
    provider: Provider,
}

impl TauriProgressReporter {
    pub fn new(app: AppHandle, provider: Provider) -> Self {
        Self { app, provider }
    }

    fn event_name(&self) -> String {
        format!("runtime-install-progress-{}", self.provider.as_str())
    }
}

#[async_trait]
impl ProgressReporter for TauriProgressReporter {
    async fn report(&self, progress: crate::runtime::types::Progress) {
        let payload = serde_json::json!({
            "provider": self.provider.as_str(),
            "progress": progress,
        });
        let _ = self.app.emit(&self.event_name(), payload.clone());
        // 也发射通用事件，便于全局监听
        let _ = self.app.emit("runtime-install-progress", payload);
    }
}

/// 检测所有 Provider 的 CodeMUX 自有 Runtime 状态。
#[tauri::command]
pub async fn check_managed_runtimes(
    state: State<'_, AppState>,
) -> Result<ManagedRuntimeCheckResult, String> {
    let resolver = &state.runtime_resolver;
    let node = detect_node().await;

    let mut runtimes = Vec::new();
    for provider in Provider::all() {
        let info = check_single_runtime(*provider, resolver, &node);
        runtimes.push(info);
    }

    Ok(ManagedRuntimeCheckResult {
        checked_at: chrono_now(),
        node,
        runtimes,
    })
}

/// 重新检测指定 Provider 的 Runtime 状态。
#[tauri::command]
pub async fn refresh_managed_runtime(
    state: State<'_, AppState>,
    provider: String,
) -> Result<ManagedRuntimeInfo, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let resolver = &state.runtime_resolver;
    let node = detect_node().await;
    Ok(check_single_runtime(provider, resolver, &node))
}

/// 安装指定 Provider 的最新版本 Runtime。
#[tauri::command]
pub async fn install_managed_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<ManagedRuntimeOperationResult, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(&state)?;
    let progress = Box::new(TauriProgressReporter::new(app.clone(), provider));
    let outcome = manager
        .install(provider, Some(progress))
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_operation_result(provider, &outcome))
}

/// 升级指定 Provider 到最新版本。
#[tauri::command]
pub async fn upgrade_managed_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<ManagedRuntimeOperationResult>, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(&state)?;
    let progress = Box::new(TauriProgressReporter::new(app.clone(), provider));
    let outcome = manager
        .upgrade(provider, Some(progress))
        .await
        .map_err(|e| e.to_string())?;
    Ok(outcome.map(|o| to_operation_result(provider, &o)))
}

/// 修复指定 Provider 的当前版本（若完整性失败则重新下载安装）。
#[tauri::command]
pub async fn repair_managed_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<ManagedRuntimeOperationResult>, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(&state)?;
    let progress = Box::new(TauriProgressReporter::new(app.clone(), provider));
    let outcome = manager
        .repair(provider, Some(progress))
        .await
        .map_err(|e| e.to_string())?;
    Ok(outcome.map(|o| to_operation_result(provider, &o)))
}

/// 删除指定 Provider 的 Runtime。
#[tauri::command]
pub async fn remove_managed_runtime(
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let resolver = &state.runtime_resolver;

    // 删除版本目录和 current 指针
    let provider_dir = resolver.root().join(provider.as_str());
    if provider_dir.exists() {
        std::fs::remove_dir_all(&provider_dir)
            .map_err(|e| format!("无法删除 Provider 目录 {}: {}", provider_dir.display(), e))?;
    }
    Ok(())
}

/// 构造生产 Runtime Manager，注入 GitHub Release manifest 源、HTTP 下载器、
/// ed25519 签名校验器、tar.gz 解压器、系统 Node 解析器和默认 Runtime 文件系统。
fn build_runtime_manager(
    state: &AppState,
) -> Result<
    RuntimeManager<
        GitHubReleaseManifestSource,
        HttpPackDownloader,
        Ed25519SignatureVerifier,
        TarGzArchiveExtractor,
        SystemNodeResolver,
        crate::runtime::seam::FileSystemRuntimeRoots,
    >,
    String,
> {
    let root = state.runtime_resolver.root().to_path_buf();
    let fs = Arc::new(crate::runtime::seam::FileSystemRuntimeRoots::new(root));
    let manifest_source = Arc::new(GitHubReleaseManifestSource::default_repo());
    let pack_downloader = Arc::new(HttpPackDownloader::with_default_client());
    let signature_verifier = Arc::new(Ed25519SignatureVerifier::with_embedded_key());
    let archive_extractor = Arc::new(TarGzArchiveExtractor::new());
    let node_resolver = Arc::new(SystemNodeResolver::new());
    Ok(RuntimeManager::new(
        manifest_source,
        pack_downloader,
        signature_verifier,
        archive_extractor,
        node_resolver,
        fs,
        env!("CARGO_PKG_VERSION"),
    ))
}

fn to_operation_result(
    provider: Provider,
    outcome: &crate::runtime::manager::InstallOutcome,
) -> ManagedRuntimeOperationResult {
    ManagedRuntimeOperationResult {
        provider: provider.as_str().to_string(),
        label: provider.label().to_string(),
        previous_version: outcome.previous_version.clone(),
        installed_version: outcome.installed_version.clone(),
        install_path: outcome.install_path.to_string_lossy().to_string(),
        switched: outcome.switched,
    }
}

async fn detect_node() -> NodeInfo {
    let resolver = SystemNodeResolver;
    let detection = resolver.detect().await;
    NodeInfo {
        available: detection.satisfies_minimum || detection.version.is_some(),
        satisfies_minimum: detection.satisfies_minimum,
        version: detection.version.map(|v| v.to_string()),
        executable_path: detection.executable_path,
        error: detection.error,
    }
}

fn check_single_runtime(
    provider: Provider,
    resolver: &crate::runtime::RuntimeResolver,
    node: &NodeInfo,
) -> ManagedRuntimeInfo {
    let installed_versions = resolver.list_installed_versions(provider);
    let current_version = resolver
        .resolve_runtime_ref(provider)
        .map(|r| r.runtime_version);
    let install_path = resolver
        .resolve_runtime_ref(provider)
        .map(|r| r.runtime_path);
    let integrity_ok = resolver.check_integrity(provider);

    let (status, message) = if !node.satisfies_minimum {
        (
            RuntimeStatus::NodeUnavailable,
            format!(
                "Node.js 不可用或版本低于 18{}",
                node.error
                    .as_ref()
                    .map(|e| format!("：{}", e))
                    .unwrap_or_default()
            ),
        )
    } else if current_version.is_none() {
        (
            RuntimeStatus::Missing,
            format!("{} 尚未安装，点击安装按钮获取", provider.label()),
        )
    } else if !integrity_ok {
        (
            RuntimeStatus::Corrupted,
            format!("{} Runtime 损坏，需要修复", provider.label()),
        )
    } else {
        (
            RuntimeStatus::Ready,
            format!(
                "{} {} 已就绪",
                provider.label(),
                current_version.as_deref().unwrap_or("未知版本")
            ),
        )
    };

    ManagedRuntimeInfo {
        provider: provider.as_str().to_string(),
        label: provider.label().to_string(),
        status,
        current_version,
        installed_versions,
        install_path,
        runtime_root: resolver.root().to_string_lossy().to_string(),
        integrity_ok,
        message,
    }
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}
