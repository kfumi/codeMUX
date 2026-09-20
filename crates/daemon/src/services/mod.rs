//! Daemon 内部服务层:原壳进程 command 层剥离 IPC 壳面后保留的核心实现。
//!
//! 由 companion HTTP 路由与 daemon 运行时直接调用,状态以
//! `&AppState` / `&DaemonState` 传参。

pub mod file;
pub mod forge;
pub mod git;
pub mod mcp;
pub mod model_provider;
pub mod provider;
pub mod runtime;
pub mod scheduled_tasks;
pub mod session;
pub mod usage;
