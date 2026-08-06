//! CodeMUX 托管 SDK Runtime 领域契约。
//!
//! 本模块定义由 CodeMUX 自己管理的 Provider Runtime（Claude / Codex / OpenCode）
//! 的统一状态、版本、完整性、安装阶段、结构化错误和可测试边界。
//!
//! 与 `agent_runtime` 模块的区别：
//! - `agent_runtime` 是 Phase-1 的会话执行 trait（当前为 stub），关注会话生命周期。
//! - `runtime` 模块描述 SDK Runtime 的安装、版本、完整性和检测契约，是 Runtime Manager、
//!   sidecar loader 和设置页共享的领域语言。
//!
//! 本模块只定义契约和可测试边界，不实现具体下载、解压或签名逻辑；这些由 `infra` 和
//! `manager` 子模块通过实现 `seam` 中的 trait 注入。

// 契约类型在 Ticket 01 阶段尚未被其他模块消费，后续 ticket 会引入引用。
#![allow(dead_code)]
#![allow(unused_imports)]

pub mod error;
pub mod infra;
pub mod manager;
pub mod manifest;
pub mod resolver;
pub mod seam;
pub mod signing;
pub mod types;

#[cfg(test)]
pub mod fixtures;

pub use error::{RuntimeError, RuntimeErrorKind};
pub use infra::{
    GitHubReleaseManifestSource, HttpPackDownloader, SystemNodeResolver, TarGzArchiveExtractor,
};
pub use manager::{InstallOutcome, RuntimeManager};
pub use manifest::{RuntimeManifest, RuntimeManifestAsset};
pub use resolver::{ProviderRuntimeRef, RuntimeResolver};
pub use seam::{
    ArchiveExtractor, CurrentVersionStore, FileSystemRuntimeRoots, ManifestSource, NodeResolver,
    PackDownloader, ProgressReporter, RuntimeFileSystem, SignatureVerifier,
};
pub use types::{
    Arch, InstallStage, NodeDetection, Platform, Progress, Provider, RuntimeIntegrityResult,
    RuntimeStatus, RuntimeVersionInfo, SemverVersion, SidecarCompatibility,
};
