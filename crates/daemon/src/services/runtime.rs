//! Runtime 管理服务(供 companion 控制面路由调用)。
//!
//! 提供统一的 Runtime 检测、安装、升级、修复、删除和重新检测入口，
//! 与外部 CLI 诊断（`agent_runtime_check`）完全分离。
//!
//! 前端通过这些命令管理 CodeMUX 自有 Runtime，不依赖 PATH 中的全局 CLI。

use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;

use crate::runtime::infra::{detect_system_node, detect_system_npm, SystemNodeResolver};
use crate::runtime::npm::NpmRuntimeManager;
use crate::runtime::seam::{NodeResolver, ProgressReporter};
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
    /// npm registry 中可安装的所有版本，按新到旧排序。
    pub available_versions: Vec<String>,
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
    pub npm: NpmInfo,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NpmInfo {
    pub available: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub matches_node: bool,
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

/// Runtime 安装进度上报:经 daemon 的 UI 事件出口投递,桌面命令路径与
/// 移动端 HTTP 路径共用同一事件契约。
///
/// 事件名:`runtime-install-progress-<provider>` 与通用 `runtime-install-progress`。
pub struct RuntimeProgressReporter {
    ui: Arc<dyn crate::daemon::UiEventSink>,
    provider: Provider,
}

impl RuntimeProgressReporter {
    pub fn new(ui: Arc<dyn crate::daemon::UiEventSink>, provider: Provider) -> Self {
        Self { ui, provider }
    }

    fn event_name(&self) -> String {
        format!("runtime-install-progress-{}", self.provider.as_str())
    }
}

#[async_trait]
impl ProgressReporter for RuntimeProgressReporter {
    async fn report(&self, progress: crate::runtime::types::Progress) {
        let payload = serde_json::json!({
            "provider": self.provider.as_str(),
            "progress": progress,
        });
        self.ui.emit(&self.event_name(), payload.clone());
        // 也发射通用事件，便于全局监听
        self.ui.emit("runtime-install-progress", payload);
    }
}

pub async fn check_managed_runtimes_impl(
    state: &AppState,
) -> Result<ManagedRuntimeCheckResult, String> {
    let resolver = &state.runtime_resolver;
    let node = detect_node().await;

    let runtimes = Provider::all()
        .iter()
        .map(|provider| check_single_runtime(*provider, resolver, &node))
        .collect();

    Ok(ManagedRuntimeCheckResult {
        checked_at: chrono_now(),
        node,
        runtimes,
    })
}

/// 查询指定 Provider 的稳定 npm Runtime 版本。
///
/// 这个命令与本地状态检测分开，避免首次打开设置页被 registry 请求阻塞；
/// 前端会在页面加载后并行调用三个 Provider，并把结果填入对应卡片。
pub async fn list_managed_runtime_versions_impl(
    state: &AppState,
    provider: String,
) -> Result<Vec<String>, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(state)?;
    manager
        .list_available_versions(provider)
        .await
        .map_err(|error| error.to_string())
}

/// 重新检测指定 Provider 的 Runtime 状态。
pub async fn refresh_managed_runtime_impl(
    state: &AppState,
    provider: String,
) -> Result<ManagedRuntimeInfo, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let resolver = &state.runtime_resolver;
    let node = detect_node().await;

    if let Ok(manager) = build_runtime_manager(state) {
        Ok(check_single_runtime_via_manager(provider, &manager, resolver, &node).await)
    } else {
        Ok(check_single_runtime(provider, resolver, &node))
    }
}

/// 使用 npm Runtime Manager 进行完整检测（含最新版本 / 可用版本 / 本地完整性）。
///
/// 当 npm 查询失败（离线、registry 不可达）时降级为本地检测，
/// 确保用户始终能看到本地 Runtime 状态。
async fn check_single_runtime_via_manager(
    provider: Provider,
    manager: &NpmRuntimeManager,
    resolver: &crate::runtime::RuntimeResolver,
    node: &NodeInfo,
) -> ManagedRuntimeInfo {
    match manager.check_status(provider).await {
        Ok(status_info) => {
            let message = build_status_message(provider, status_info.status, &status_info);
            ManagedRuntimeInfo {
                provider: provider.as_str().to_string(),
                label: provider.label().to_string(),
                status: status_info.status,
                current_version: status_info.current_version,
                installed_versions: resolver.list_installed_versions(provider),
                available_versions: status_info.available_versions,
                install_path: status_info
                    .install_path
                    .map(|p| p.to_string_lossy().to_string()),
                runtime_root: resolver.root().to_string_lossy().to_string(),
                integrity_ok: status_info.integrity_ok,
                message,
            }
        }
        Err(_) => {
            // npm registry 查询失败等情况下，降级为纯本地检测
            check_single_runtime(provider, resolver, node)
        }
    }
}

fn build_status_message(
    provider: Provider,
    status: RuntimeStatus,
    info: &crate::runtime::npm::NpmRuntimeStatusInfo,
) -> String {
    match status {
        RuntimeStatus::NodeUnavailable => format!(
            "Node.js 不可用或版本低于 18{}",
            info.node
                .error
                .as_ref()
                .map(|e| format!("：{}", e))
                .unwrap_or_default()
        ),
        RuntimeStatus::Missing => format!("{} 尚未安装，点击安装按钮获取", provider.label()),
        RuntimeStatus::Corrupted => format!("{} Runtime 损坏，需要修复", provider.label()),
        RuntimeStatus::Outdated => format!(
            "{} {} 可更新到 {}",
            provider.label(),
            info.current_version.as_deref().unwrap_or("未知版本"),
            info.latest_version.as_deref().unwrap_or("最新版本")
        ),
        RuntimeStatus::Ready => format!(
            "{} {} 已就绪",
            provider.label(),
            info.current_version.as_deref().unwrap_or("未知版本")
        ),
        RuntimeStatus::Installing => format!("{} 正在安装中", provider.label()),
        RuntimeStatus::Error => format!("{} Runtime 状态异常", provider.label()),
    }
}

/// 安装指定 Provider 的最新版本 Runtime。
pub async fn install_managed_runtime_impl(
    state: &AppState,
    provider: String,
    version: Option<String>,
    progress: Arc<dyn ProgressReporter>,
) -> Result<ManagedRuntimeOperationResult, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(state)?;

    let outcome = match version.as_deref() {
        Some(version) => {
            manager
                .install_version(provider, version, progress.as_ref())
                .await
        }
        None => manager.install(provider, progress.as_ref()).await,
    }
    .map_err(|e| e.to_string())?;
    Ok(to_operation_result(provider, &outcome))
}

/// 升级指定 Provider 到最新版本。
pub async fn upgrade_managed_runtime_impl(
    state: &AppState,
    provider: String,
    progress: Arc<dyn ProgressReporter>,
) -> Result<Option<ManagedRuntimeOperationResult>, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(state)?;
    let outcome = manager
        .upgrade(provider, progress.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(outcome.map(|o| to_operation_result(provider, &o)))
}

/// 修复指定 Provider 的当前版本（若完整性失败则重新下载安装）。
pub async fn repair_managed_runtime_impl(
    state: &AppState,
    provider: String,
    progress: Arc<dyn ProgressReporter>,
) -> Result<Option<ManagedRuntimeOperationResult>, String> {
    let provider =
        Provider::from_str(&provider).ok_or_else(|| format!("未知的 Provider: {}", provider))?;
    let manager = build_runtime_manager(state)?;
    let outcome = manager
        .repair(provider, progress.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(outcome.map(|o| to_operation_result(provider, &o)))
}

/// 删除指定 Provider 的 Runtime。
pub async fn remove_managed_runtime_impl(state: &AppState, provider: String) -> Result<(), String> {
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

/// 构造生产 Runtime Manager：版本和安装均通过官方 npm CLI 完成。
fn build_runtime_manager(state: &AppState) -> Result<NpmRuntimeManager, String> {
    let node = detect_system_node();
    if !node.satisfies_minimum {
        return Err(node
            .error
            .unwrap_or_else(|| "Node.js 18+ 不可用".to_string()));
    }
    let npm = detect_system_npm(&node);
    if !npm.available {
        return Err(npm.error.unwrap_or_else(|| "npm 不可用".to_string()));
    }
    if !npm.matches_node {
        return Err(npm
            .error
            .unwrap_or_else(|| "npm 与 Node.js 安装不匹配".to_string()));
    }
    let root = state.runtime_resolver.root().to_path_buf();
    Ok(NpmRuntimeManager::production(
        root,
        env!("CARGO_PKG_VERSION"),
    ))
}

fn to_operation_result(
    provider: Provider,
    outcome: &crate::runtime::npm::InstallOutcome,
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
    let npm = detect_system_npm(&detection);
    NodeInfo {
        available: detection.satisfies_minimum || detection.version.is_some(),
        satisfies_minimum: detection.satisfies_minimum,
        version: detection.version.map(|v| v.to_string()),
        executable_path: detection.executable_path,
        error: detection.error,
        npm: NpmInfo {
            available: npm.available,
            version: npm.version,
            executable_path: npm.executable_path,
            matches_node: npm.matches_node,
            error: npm.error,
        },
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
        available_versions: Vec::new(),
        install_path,
        runtime_root: resolver.root().to_string_lossy().to_string(),
        integrity_ok,
        message,
    }
}

fn chrono_now() -> String {
    chrono::Local::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::chrono_now;

    #[test]
    fn check_timestamp_is_human_readable_rfc3339() {
        let timestamp = chrono_now();
        assert!(chrono::DateTime::parse_from_rfc3339(&timestamp).is_ok());
    }
}
