//! CodeMUX daemon 库:权威进程(SQLite、Session、Agent、Sidecar、MCP、
//! skills、定时任务、companion HTTP/WS 服务)的全部核心逻辑。
//!
//! 桌面壳已切换为 Electron(`apps/desktop/`),Rust 侧不再包含任何
//! 窗口/托盘/通知/更新器代码;壳以 supervisor 身份拉起 `codemux-daemon`
//! 二进制并经 HTTP/WS 消费其能力。
//!
//! 入口面:
//! - 无壳独立运行 daemon:[`daemon::run_daemon_standalone`];
//! - 核心状态组装与「daemon → 桌面 UI」领域事件出口(Electron main 经 WS
//!   客户端承接):[`daemon::DaemonState`] / [`daemon::UiEventSink`];
//! - 注入式环境根:[`paths::PathRoots`];
//! - daemon 进程内共享状态束:[`AppState`]。

mod agent;
mod agent_runtime;
pub mod browser_mcp;
pub mod companion;
pub mod computer_use;
mod config;
pub mod daemon;
mod db;
mod forge;
mod log_ctx;
mod mcp;
mod model_providers;
pub mod paths;
mod provider_profiles;
mod runtime;
mod scheduled_tasks;
mod services;
mod skills;
mod terminal;

pub mod work_tasks;

use std::sync::Mutex;

/// daemon 进程内共享状态:数据库连接、配置、数据目录与 Runtime 解析器。
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    pub app_data_dir: std::path::PathBuf,
    pub runtime_resolver: crate::runtime::RuntimeResolver,
}

pub use daemon::{run_daemon_standalone, DaemonState, NullUiEventSink, UiEventSink};
