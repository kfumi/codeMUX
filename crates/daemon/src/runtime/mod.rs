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
//! npm 查询、安装和切换逻辑集中在 `npm` 子模块；`infra` 只负责检测 Node.js，
//! `seam` 提供可测试的进度与文件系统边界。

// 契约类型在 Ticket 01 阶段尚未被其他模块消费，后续 ticket 会引入引用。
#![allow(dead_code)]
#![allow(unused_imports)]

pub mod error;
pub mod infra;
pub mod npm;
pub mod resolver;
pub mod seam;
pub mod types;

#[cfg(test)]
pub mod fixtures;

pub use error::{RuntimeError, RuntimeErrorKind};
pub use infra::{detect_system_node, detect_system_npm, SystemNodeResolver};
pub use npm::{
    InstallOutcome, NpmRuntimeInstaller, NpmRuntimeManager, NpmRuntimeSource, NpmRuntimeSpec,
};
pub use resolver::{ProviderRuntimeRef, RuntimeResolver};
pub use seam::{
    CurrentVersionStore, FileSystemRuntimeRoots, NodeResolver, ProgressReporter, RuntimeFileSystem,
};
pub use types::{
    Arch, InstallStage, NodeDetection, NpmDetection, Platform, Progress, Provider,
    RuntimeIntegrityResult, RuntimeStatus, RuntimeVersionInfo, SemverVersion, SidecarCompatibility,
};
