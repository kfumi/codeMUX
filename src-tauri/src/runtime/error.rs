//! Runtime 领域的结构化错误。
//!
//! npm Runtime Manager 返回结构化错误，区分 registry 查询、npm 安装、完整性、权限、
//! Node 不可用和回滚失败等情况。

use serde::{Deserialize, Serialize};

use super::types::{InstallStage, Provider};

/// Runtime 操作错误种类。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorKind {
    /// npm registry 查询或版本解析失败。
    ManifestFailed,
    /// npm 安装失败（网络、registry、依赖或 postinstall 失败）。
    DownloadFailed,
    /// 关键文件或二进制完整性校验失败。
    IntegrityFailed,
    /// sidecar 兼容性不匹配。
    CompatibilityFailed,
    /// 文件系统权限失败（无法写入用户级目录）。
    PermissionFailed,
    /// 系统 Node.js 不可用或版本过低。
    NodeUnavailable,
    /// 回滚失败（旧版本已删除或损坏）。
    RollbackFailed,
    /// 同一 Provider 已有进行中的安装任务（互斥触发）。
    Busy,
    /// 操作被取消。
    Cancelled,
    /// 通用 IO 错误。
    IoFailed,
    /// 其他未分类错误。
    Unknown,
}

impl RuntimeErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ManifestFailed => "manifest_failed",
            Self::DownloadFailed => "download_failed",
            Self::IntegrityFailed => "integrity_failed",
            Self::CompatibilityFailed => "compatibility_failed",
            Self::PermissionFailed => "permission_failed",
            Self::NodeUnavailable => "node_unavailable",
            Self::RollbackFailed => "rollback_failed",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::IoFailed => "io_failed",
            Self::Unknown => "unknown",
        }
    }

    /// 错误是否可由用户重试恢复。
    pub fn is_recoverable(&self) -> bool {
        match self {
            Self::ManifestFailed | Self::DownloadFailed | Self::IoFailed | Self::Unknown => true,
            // 签名、哈希、完整性、兼容性失败通常需要更换 manifest 或版本。
            Self::IntegrityFailed | Self::CompatibilityFailed => true,
            // 权限失败需要用户介入调整目录权限后重试。
            Self::PermissionFailed => true,
            // Node 不可用需要用户安装 Node，恢复后重试。
            Self::NodeUnavailable => true,
            // Busy 是临时状态，调用方应复用进行中任务或稍后重试。
            Self::Busy => true,
            // 取消不可重试，需用户重新发起。
            Self::Cancelled => false,
            // 回滚失败通常意味着旧版本已不可用，需用户重新安装。
            Self::RollbackFailed => true,
        }
    }

    /// 用户可读的错误类别名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::ManifestFailed => "npm registry 查询失败",
            Self::DownloadFailed => "npm 安装失败",
            Self::IntegrityFailed => "Runtime 完整性校验失败",
            Self::CompatibilityFailed => "Runtime 兼容性不匹配",
            Self::PermissionFailed => "文件系统权限不足",
            Self::NodeUnavailable => "Node.js 不可用",
            Self::RollbackFailed => "Runtime 回滚失败",
            Self::Busy => "Runtime 正在安装中",
            Self::Cancelled => "操作已取消",
            Self::IoFailed => "文件读写失败",
            Self::Unknown => "未知错误",
        }
    }
}

/// 结构化 Runtime 错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub kind: RuntimeErrorKind,
    pub provider: Option<Provider>,
    /// 失败时所处的阶段（若适用）。
    pub stage: Option<InstallStage>,
    /// 用户可读的错误详情。
    pub message: String,
    /// 是否可通过重试恢复。
    pub recoverable: bool,
}

impl RuntimeError {
    pub fn new(
        kind: RuntimeErrorKind,
        provider: Option<Provider>,
        stage: Option<InstallStage>,
        message: impl Into<String>,
    ) -> Self {
        let recoverable = kind.is_recoverable();
        Self {
            kind,
            provider,
            stage,
            message: message.into(),
            recoverable,
        }
    }

    pub fn manifest_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(
            RuntimeErrorKind::ManifestFailed,
            provider,
            Some(InstallStage::Resolving),
            message,
        )
    }

    pub fn download_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(
            RuntimeErrorKind::DownloadFailed,
            provider,
            Some(InstallStage::Downloading),
            message,
        )
    }

    pub fn integrity_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(
            RuntimeErrorKind::IntegrityFailed,
            provider,
            Some(InstallStage::VerifyingIntegrity),
            message,
        )
    }

    pub fn compatibility_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(
            RuntimeErrorKind::CompatibilityFailed,
            provider,
            Some(InstallStage::VerifyingIntegrity),
            message,
        )
    }

    pub fn permission_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(RuntimeErrorKind::PermissionFailed, provider, None, message)
    }

    pub fn node_unavailable(message: impl Into<String>) -> Self {
        Self::new(RuntimeErrorKind::NodeUnavailable, None, None, message)
    }

    pub fn rollback_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(
            RuntimeErrorKind::RollbackFailed,
            provider,
            Some(InstallStage::Switching),
            message,
        )
    }

    pub fn busy(provider: Provider) -> Self {
        Self::new(
            RuntimeErrorKind::Busy,
            Some(provider),
            None,
            format!("{} 已有进行中的安装任务", provider.label()),
        )
    }

    pub fn io_failed(provider: Option<Provider>, message: impl Into<String>) -> Self {
        Self::new(RuntimeErrorKind::IoFailed, provider, None, message)
    }
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let provider = self.provider.map(|p| p.label()).unwrap_or("Runtime");
        let stage = self
            .stage
            .map(|s| s.label())
            .unwrap_or_else(|| self.kind.label());
        write!(f, "{}: {} — {}", provider, stage, self.message)
    }
}

impl std::error::Error for RuntimeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_via_string() {
        for kind in [
            RuntimeErrorKind::ManifestFailed,
            RuntimeErrorKind::DownloadFailed,
            RuntimeErrorKind::IntegrityFailed,
            RuntimeErrorKind::CompatibilityFailed,
            RuntimeErrorKind::PermissionFailed,
            RuntimeErrorKind::NodeUnavailable,
            RuntimeErrorKind::RollbackFailed,
            RuntimeErrorKind::Busy,
            RuntimeErrorKind::Cancelled,
            RuntimeErrorKind::IoFailed,
            RuntimeErrorKind::Unknown,
        ] {
            assert!(!kind.as_str().is_empty());
        }
    }

    #[test]
    fn busy_error_is_recoverable_and_carries_provider() {
        let err = RuntimeError::busy(Provider::Codex);
        assert_eq!(err.kind, RuntimeErrorKind::Busy);
        assert_eq!(err.provider, Some(Provider::Codex));
        assert!(err.recoverable);
        assert!(err.message.contains("Codex"));
    }

    #[test]
    fn cancelled_is_not_recoverable() {
        let err = RuntimeError::new(
            RuntimeErrorKind::Cancelled,
            Some(Provider::ClaudeCode),
            None,
            "user cancelled",
        );
        assert!(!err.recoverable);
    }

    #[test]
    fn helper_constructors_attach_stage() {
        let err = RuntimeError::download_failed(Some(Provider::OpenCode), "timeout");
        assert_eq!(err.stage, Some(InstallStage::Downloading));

        let err = RuntimeError::integrity_failed(Some(Provider::OpenCode), "missing binary");
        assert_eq!(err.stage, Some(InstallStage::VerifyingIntegrity));
    }

    #[test]
    fn node_unavailable_has_no_provider() {
        let err = RuntimeError::node_unavailable("node not found");
        assert_eq!(err.kind, RuntimeErrorKind::NodeUnavailable);
        assert_eq!(err.provider, None);
        assert!(err.recoverable);
    }

    #[test]
    fn display_includes_provider_stage_and_message() {
        let err = RuntimeError::integrity_failed(Some(Provider::ClaudeCode), "missing SDK package");
        let rendered = err.to_string();
        assert!(rendered.contains("Claude Code"));
        assert!(rendered.contains("missing SDK package"));
    }
}
