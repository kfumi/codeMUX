//! Daemon 核心的显式状态组装。
//!
//! [`DaemonState`] 是不含任何 Tauri 类型的权威状态束:独立二进制、测试与
//! Tauri 壳引导都经 [`DaemonState::assemble`] 构造同一形状。壳把其中的
//! Arc 逐个 manage 给命令层(`State<'_, Arc<X>>`);回环 Companion 服务、
//! 定时任务循环与 sidecar 事件转发直接持有 [`Arc<DaemonState>`],不经
//! Tauri 状态注入取态。
//!
//! 领域事件到桌面 UI 的通知属于壳能力:daemon 经 [`UiEventSink`] 抽象发
//! 事件,Tauri 壳绑定 `shell::TauriUiEventSink`(tauri emit),headless
//! 运行与测试传 [`NullUiEventSink`]。

use std::sync::Arc;

use crate::agent::session_lifecycle::AgentState;
use crate::commands::terminal::TerminalState;
use crate::companion::CompanionState;
use crate::paths::PathRoots;

/// daemon → 壳 UI 的领域事件出口。失败静默,与原 tauri emit 的调用侧行为一致。
pub trait UiEventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 丢弃一切 UI 事件的 sink:headless 运行与测试用。
pub struct NullUiEventSink;

impl UiEventSink for NullUiEventSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

pub struct DaemonState {
    pub roots: PathRoots,
    pub app: Arc<crate::AppState>,
    pub agent: Arc<AgentState>,
    pub terminal: Arc<TerminalState>,
    pub companion: Arc<CompanionState>,
    pub ui_events: Arc<dyn UiEventSink>,
}

impl DaemonState {
    /// 无窗口可用的核心组装:初始化数据库、加载配置、装配全部状态。
    pub fn assemble(roots: PathRoots, ui_events: Arc<dyn UiEventSink>) -> Result<Self, String> {
        let conn = crate::db::initialize(&roots)?;
        let config = crate::config::load_config(&roots);
        Ok(Self {
            app: Arc::new(crate::AppState {
                db: std::sync::Mutex::new(conn),
                config: std::sync::Mutex::new(config),
                app_data_dir: roots.app_data_dir.clone(),
                runtime_resolver: crate::runtime::RuntimeResolver::default_root(),
            }),
            agent: Arc::new(AgentState::default()),
            terminal: Arc::new(TerminalState::default()),
            companion: Arc::new(CompanionState::default()),
            roots,
            ui_events,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{DaemonState, NullUiEventSink};
    use crate::paths::PathRoots;
    use std::sync::Arc;

    #[test]
    fn assembles_full_core_without_tauri_app() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().to_path_buf(),
            resource_dir: None,
        };

        let daemon = DaemonState::assemble(roots, Arc::new(NullUiEventSink)).expect("assemble");

        assert!(temp.path().join("codemux.db").is_file());
        assert_eq!(daemon.app.app_data_dir, temp.path());
        assert_eq!(daemon.roots.database_path(), temp.path().join("codemux.db"));
    }
}
