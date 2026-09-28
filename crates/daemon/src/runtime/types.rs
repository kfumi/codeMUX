//! Runtime 领域的核心类型：Provider、平台、架构、版本、状态、Node 检测、完整性、阶段与进度。

use std::fmt;

use serde::{Deserialize, Serialize};

/// CodeMUX 托管的 Provider Runtime 种类。
///
/// 字符串值与现有 `agent_kind` 保持一致，便于前端、sidecar 和 Rust 共享同一命名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    ClaudeCode,
    Codex,
    OpenCode,
    Pi,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }

    /// 用户可读的展示名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::Pi => "pi",
        }
    }

    /// 对应的全局 CLI 命令名（仅用于外部 CLI 诊断，不决定 Runtime 状态）。
    pub fn cli_command(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "claude_code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    pub fn all() -> &'static [Provider] {
        &[
            Provider::ClaudeCode,
            Provider::Codex,
            Provider::OpenCode,
            Provider::Pi,
        ]
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 支持的目标平台。本期优先实现 Windows x64，模型保留扩展能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "windows" => Some(Self::Windows),
            "macos" => Some(Self::Macos),
            "linux" => Some(Self::Linux),
            _ => None,
        }
    }

    /// 当前进程运行的目标平台。
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Self::Linux
        }
    }
}

/// CPU 架构。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    X64,
    Arm64,
}

impl Arch {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::X64 => "x64",
            Self::Arm64 => "arm64",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "x64" | "x86_64" | "amd64" => Some(Self::X64),
            "arm64" | "aarch64" => Some(Self::Arm64),
            _ => None,
        }
    }

    /// 当前进程架构。
    pub fn current() -> Self {
        #[cfg(target_arch = "x86_64")]
        {
            Self::X64
        }
        #[cfg(target_arch = "aarch64")]
        {
            Self::Arm64
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            Self::X64
        }
    }
}

/// Runtime 状态。描述 CodeMUX 自有 Runtime，不得由外部 CLI 缺失推导为不可用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    /// 未安装。
    Missing,
    /// 正在安装 / 升级 / 修复中。
    Installing,
    /// 已安装且通过完整性校验，可用于会话。
    Ready,
    /// 已安装但有更新版本可用。
    Outdated,
    /// 安装目录存在但关键文件 / 二进制缺失或校验失败。
    Corrupted,
    /// 系统 Node.js 不可用或版本低于 18。
    NodeUnavailable,
    /// 检测或操作出现异常（manifest 拉取失败、IO 错误等）。
    Error,
}

impl RuntimeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Installing => "installing",
            Self::Ready => "ready",
            Self::Outdated => "outdated",
            Self::Corrupted => "corrupted",
            Self::NodeUnavailable => "node_unavailable",
            Self::Error => "error",
        }
    }
}

/// 语义化版本。仅解析 `major.minor.patch`，预发布标签保留为原始字符串。
///
/// 用于版本比较（最新版 vs 当前版、sidecar 兼容性）。非语义化输入退化为按字符串比较。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemverVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// 原始版本字符串（保留预发布 / build 元信息），用于回显和精确匹配。
    pub raw: String,
}

impl SemverVersion {
    /// 解析版本字符串。失败时返回 `None`，调用方按字符串比较回退。
    pub fn parse(value: &str) -> Option<Self> {
        let trimmed = value.trim();
        let core = trimmed
            .strip_prefix('v')
            .or_else(|| trimmed.strip_prefix('V'))
            .unwrap_or(trimmed);
        let core = core.split('-').next().unwrap_or(core);
        let core = core.split('+').next().unwrap_or(core);
        let mut parts = core.split('.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
        let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            raw: trimmed.to_string(),
        })
    }

    pub fn is_newer_than(&self, other: &SemverVersion) -> bool {
        (self.major, self.minor, self.patch) > (other.major, other.minor, other.patch)
    }
}

impl fmt::Display for SemverVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

/// sidecar 兼容性描述。manifest 声明兼容的 sidecar 版本范围（语义化版本要求）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidecarCompatibility {
    /// 兼容的 sidecar 版本（当前 sidecar 自报版本）。
    pub sidecar_version: String,
    /// manifest 声明的兼容版本要求，例如 `>=0.2.0` 或 `0.2.x`。
    pub required_range: String,
    /// 是否满足。
    pub satisfied: bool,
}

/// 已安装 Runtime 的版本与路径信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersionInfo {
    /// 当前启用的版本（从 current version 指针读取）。
    pub current_version: Option<String>,
    /// 当前版本安装目录绝对路径。
    pub install_path: Option<String>,
    /// manifest 中声明的最新可用版本。
    pub latest_version: Option<String>,
}

/// 系统 Node.js 检测结果。Node 18+ 是 CodeMUX Runtime 的硬性前置依赖。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetection {
    pub available: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    /// 是否满足 Node 18+ 最低要求。
    pub satisfies_minimum: bool,
    /// 检测失败时的用户可读错误。
    pub error: Option<String>,
}

/// 系统 npm 检测结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NpmDetection {
    pub available: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub matches_node: bool,
    pub error: Option<String>,
}

impl NpmDetection {
    pub fn unavailable(error: impl Into<String>, executable_path: Option<String>) -> Self {
        Self {
            available: false,
            version: None,
            executable_path,
            matches_node: false,
            error: Some(error.into()),
        }
    }
}

impl NodeDetection {
    /// Node 最低主版本号。
    pub const MINIMUM_MAJOR: u64 = 18;

    pub fn unavailable(error: impl Into<String>) -> Self {
        Self {
            available: false,
            version: None,
            executable_path: None,
            satisfies_minimum: false,
            error: Some(error.into()),
        }
    }

    pub fn from_version(version: Option<String>, executable_path: Option<String>) -> Self {
        let satisfies = version
            .as_deref()
            .and_then(SemverVersion::parse)
            .map(|v| v.major >= Self::MINIMUM_MAJOR)
            .unwrap_or(false);
        let available = version.is_some();
        Self {
            available,
            version,
            executable_path,
            satisfies_minimum: satisfies,
            error: if available {
                None
            } else {
                Some("无法解析 Node.js 版本".to_string())
            },
        }
    }
}

/// Runtime 完整性校验结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIntegrityResult {
    pub ok: bool,
    /// 缺失的关键文件（相对 Runtime 根目录的路径）。
    pub missing_files: Vec<String>,
    /// 缺失或无法执行的关键二进制。
    pub missing_binaries: Vec<String>,
    /// 用户可读的摘要。
    pub message: String,
}

impl RuntimeIntegrityResult {
    pub fn ok() -> Self {
        Self {
            ok: true,
            missing_files: Vec::new(),
            missing_binaries: Vec::new(),
            message: "完整性校验通过".to_string(),
        }
    }

    pub fn failed(missing_files: Vec<String>, missing_binaries: Vec<String>) -> Self {
        let mut parts = Vec::new();
        if !missing_files.is_empty() {
            parts.push(format!("缺失文件: {}", missing_files.join(", ")));
        }
        if !missing_binaries.is_empty() {
            parts.push(format!("缺失二进制: {}", missing_binaries.join(", ")));
        }
        Self {
            ok: false,
            missing_files,
            missing_binaries,
            message: parts.join("; "),
        }
    }
}

/// 安装 / 升级 / 修复流程的阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStage {
    /// 查询 npm registry 并选择版本。
    Resolving,
    /// 执行 npm 安装。
    Downloading,
    /// 校验关键文件与二进制完整性。
    VerifyingIntegrity,
    /// 切换当前版本指针。
    Switching,
    /// 清理旧版本。
    Cleaning,
    /// 流程完成。
    Done,
    /// 流程失败。
    Failed,
}

impl InstallStage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Resolving => "resolving",
            Self::Downloading => "downloading",
            Self::VerifyingIntegrity => "verifying_integrity",
            Self::Switching => "switching",
            Self::Cleaning => "cleaning",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    /// 用户可读的阶段名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Resolving => "查询 npm 版本",
            Self::Downloading => "执行 npm 安装",
            Self::VerifyingIntegrity => "校验完整性",
            Self::Switching => "切换版本",
            Self::Cleaning => "清理旧版本",
            Self::Done => "完成",
            Self::Failed => "失败",
        }
    }
}

/// 安装进度。用于前端展示进度条与阶段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: InstallStage,
    /// 0-100，未知时为 `None`。
    ///
    /// `skip_serializing_if` 不是可选的洁癖：前端按"字段缺失"判断进度未知，
    /// 而 `None` 默认序列化成 `null`，会让前端把"没有数据"渲染成一个假的 0%。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Progress {
    pub fn new(stage: InstallStage) -> Self {
        Self {
            stage,
            percent: None,
            bytes_done: None,
            bytes_total: None,
            message: None,
        }
    }

    pub fn with_percent(mut self, percent: u8) -> Self {
        self.percent = Some(percent.min(100));
        self
    }

    pub fn with_bytes(mut self, done: u64, total: u64) -> Self {
        self.bytes_done = Some(done);
        self.bytes_total = Some(total);
        if total > 0 {
            self.percent = Some(((done as f64 / total as f64) * 100.0) as u8);
        }
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_round_trips() {
        for provider in Provider::all() {
            assert_eq!(Provider::from_str(provider.as_str()), Some(*provider));
        }
        assert_eq!(Provider::from_str("unknown"), None);
    }

    #[test]
    fn provider_labels_and_commands() {
        assert_eq!(Provider::ClaudeCode.label(), "Claude Code");
        assert_eq!(Provider::Codex.label(), "Codex");
        assert_eq!(Provider::OpenCode.label(), "OpenCode");
        assert_eq!(Provider::Pi.label(), "pi");
        assert_eq!(Provider::ClaudeCode.cli_command(), "claude");
        assert_eq!(Provider::Codex.cli_command(), "codex");
        assert_eq!(Provider::OpenCode.cli_command(), "opencode");
        assert_eq!(Provider::Pi.cli_command(), "pi");
    }

    #[test]
    fn platform_round_trips() {
        assert_eq!(Platform::from_str("windows"), Some(Platform::Windows));
        assert_eq!(Platform::from_str("macos"), Some(Platform::Macos));
        assert_eq!(Platform::from_str("linux"), Some(Platform::Linux));
        assert_eq!(Platform::from_str("unknown"), None);
    }

    #[test]
    fn arch_accepts_aliases() {
        assert_eq!(Arch::from_str("x64"), Some(Arch::X64));
        assert_eq!(Arch::from_str("x86_64"), Some(Arch::X64));
        assert_eq!(Arch::from_str("amd64"), Some(Arch::X64));
        assert_eq!(Arch::from_str("arm64"), Some(Arch::Arm64));
        assert_eq!(Arch::from_str("aarch64"), Some(Arch::Arm64));
        assert_eq!(Arch::from_str("unknown"), None);
    }

    #[test]
    fn status_strings_match_spec() {
        assert_eq!(RuntimeStatus::Missing.as_str(), "missing");
        assert_eq!(RuntimeStatus::Installing.as_str(), "installing");
        assert_eq!(RuntimeStatus::Ready.as_str(), "ready");
        assert_eq!(RuntimeStatus::Outdated.as_str(), "outdated");
        assert_eq!(RuntimeStatus::Corrupted.as_str(), "corrupted");
        assert_eq!(RuntimeStatus::NodeUnavailable.as_str(), "node_unavailable");
        assert_eq!(RuntimeStatus::Error.as_str(), "error");
    }

    #[test]
    fn semver_parses_plain_versions() {
        let v = SemverVersion::parse("1.2.3").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        assert_eq!(v.raw, "1.2.3");
    }

    #[test]
    fn semver_strips_v_prefix_and_prerelease() {
        let v = SemverVersion::parse("v0.3.169-beta.1").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (0, 3, 169));
        assert_eq!(v.raw, "v0.3.169-beta.1");
    }

    #[test]
    fn semver_is_newer_than_compares_numeric() {
        let a = SemverVersion::parse("1.2.3").unwrap();
        let b = SemverVersion::parse("1.2.2").unwrap();
        assert!(a.is_newer_than(&b));
        assert!(!b.is_newer_than(&a));
        assert!(!a.is_newer_than(&SemverVersion::parse("1.2.3").unwrap()));
    }

    #[test]
    fn semver_rejects_non_semantic_input() {
        assert!(SemverVersion::parse("not-a-version").is_none());
        assert!(SemverVersion::parse("").is_none());
        assert!(SemverVersion::parse("1.2.3.4").is_none());
    }

    #[test]
    fn node_detection_from_version_checks_minimum() {
        let ok = NodeDetection::from_version(
            Some("v20.10.0".to_string()),
            Some("/usr/bin/node".to_string()),
        );
        assert!(ok.available);
        assert!(ok.satisfies_minimum);

        let too_old = NodeDetection::from_version(
            Some("v16.20.0".to_string()),
            Some("/usr/bin/node".to_string()),
        );
        assert!(too_old.available);
        assert!(!too_old.satisfies_minimum);
    }

    #[test]
    fn node_detection_unavailable_carries_error() {
        let d = NodeDetection::unavailable("node not found in PATH");
        assert!(!d.available);
        assert!(!d.satisfies_minimum);
        assert_eq!(d.error.as_deref(), Some("node not found in PATH"));
    }

    #[test]
    fn integrity_result_ok_and_failed() {
        let ok = RuntimeIntegrityResult::ok();
        assert!(ok.ok);
        assert!(ok.missing_files.is_empty());

        let failed = RuntimeIntegrityResult::failed(
            vec!["package.json".to_string()],
            vec!["bin/claude".to_string()],
        );
        assert!(!failed.ok);
        assert_eq!(failed.missing_files.len(), 1);
        assert_eq!(failed.missing_binaries.len(), 1);
        assert!(failed.message.contains("package.json"));
        assert!(failed.message.contains("bin/claude"));
    }

    #[test]
    fn install_stage_labels_are_localized() {
        assert_eq!(InstallStage::Downloading.label(), "执行 npm 安装");
        assert_eq!(InstallStage::Done.label(), "完成");
        assert_eq!(InstallStage::Failed.as_str(), "failed");
    }

    #[test]
    fn progress_with_bytes_derives_percent() {
        let p = Progress::new(InstallStage::Downloading).with_bytes(50, 200);
        assert_eq!(p.percent, Some(25));
        assert_eq!(p.bytes_done, Some(50));
        assert_eq!(p.bytes_total, Some(200));
    }

    #[test]
    fn progress_with_percent_clamps() {
        let p = Progress::new(InstallStage::Downloading).with_percent(150);
        assert_eq!(p.percent, Some(100));
    }
}
