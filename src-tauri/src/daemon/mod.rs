//! Daemon 核心的显式状态组装。
//!
//! [`DaemonState`] 是不含任何壳类型的权威状态束:独立二进制、测试与
//! 壳侧引导都经 [`DaemonState::assemble`] 构造同一形状。回环 Companion
//! 服务、定时任务循环与 sidecar 事件转发直接持有 [`Arc<DaemonState>`]。
//!
//! 领域事件到桌面 UI 的通知属于壳能力:daemon 经 [`UiEventSink`] 抽象发
//! 事件,Electron 壳经其 daemon WS 客户端承接后转发渲染层,headless
//! 运行与测试传 [`NullUiEventSink`]。

use log::{info, warn};
use std::sync::Arc;

use crate::agent::session_lifecycle::AgentState;
use crate::companion::state::CompanionBroadcastEvent;
use crate::companion::CompanionState;
use crate::paths::PathRoots;
use crate::terminal::TerminalState;

pub mod run_state;

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// daemon → 壳 UI 的领域事件出口。失败静默,调用方不依赖投递结果。
pub trait UiEventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 丢弃一切 UI 事件的 sink:headless 运行与测试用。
pub struct NullUiEventSink;

impl UiEventSink for NullUiEventSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

/// 控制面 WS 广播 sink:把 daemon UI 事件(sessions-changed /
/// scheduled-tasks-changed / runtime-install-progress* 等)以 `ui-event` 信封、
/// 空 session_id 发进 companion 广播通道;控制面 WS(`/api/ws` 无 session_id)
/// 只转发空 session_id 事件,已连接的壳(Electron main 的 daemon WS 客户端)
/// 据此经 webContents.send(同名事件名)投递渲染层。CompanionState 在
/// [`DaemonState::assemble`] 内创建,故用 [`OnceLock`] 在组装后回填。
pub struct WsUiEventSink {
    companion: std::sync::OnceLock<Arc<CompanionState>>,
}

impl WsUiEventSink {
    pub fn new() -> Self {
        Self {
            companion: std::sync::OnceLock::new(),
        }
    }

    /// 组装完成后回填 companion 广播通道(重复调用忽略)。
    pub fn attach(&self, companion: Arc<CompanionState>) {
        let _ = self.companion.set(companion);
    }
}

impl Default for WsUiEventSink {
    fn default() -> Self {
        Self::new()
    }
}

impl UiEventSink for WsUiEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Some(companion) = self.companion.get() {
            let envelope = serde_json::json!({
                "type": "ui-event",
                "name": event,
                "payload": payload,
            });
            let _ = companion.inner.event_tx.send(CompanionBroadcastEvent {
                session_id: String::new(),
                event: envelope,
            });
        }
    }
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

/// 无壳独立运行 daemon:组装核心 → 一次性清理遗留时间线产物 → 启动回环
/// 服务 → 写 run-state → 跑定时任务循环 → 收到关闭信号后优雅退出并清理
/// run-state。
pub async fn run_daemon_standalone(
    roots: PathRoots,
    managed_by: String,
    port_override: Option<u16>,
) -> Result<(), String> {
    // UI 事件经控制面 WS 广播给壳(Electron main 的 daemon WS 客户端承接后
    // 转发渲染层);attach 在 assemble 之后回填 companion 广播通道。
    let ui_sink = Arc::new(WsUiEventSink::new());
    let daemon = Arc::new(DaemonState::assemble(roots, ui_sink.clone())?);
    ui_sink.attach(daemon.companion.clone());
    // 一次性遗留数据迁移:原先由壳进程在启动时执行,现随权威 daemon 走。
    crate::agent::history_import::cleanup_legacy_timeline_artifacts(&daemon).await;
    let (port, expose_lan, listen_address) = {
        let config = daemon.app.config.lock().unwrap();
        (
            port_override.unwrap_or(config.companion.port),
            // 移动伴侣开关是持久设置:上次开着就按局域网暴露启动(ADR 0008
            // amendment,companion.enabled 只控制对外暴露)。
            config.companion.enabled,
            config.companion.listen_address.clone(),
        )
    };

    let started_exposed = expose_lan
        && crate::companion::start_daemon_server(
            daemon.clone(),
            port,
            true,
            listen_address.clone(),
        )
        .await
        .is_ok();
    if !started_exposed {
        if expose_lan {
            // 局域网绑定失败(地址被占等)不能让 daemon 起不来:退回归环,由设置页
            // 的开关重新触发。daemon_error 已由 start_daemon_server 记录。
            warn!(
                target: "daemon",
                "Failed to expose mobile companion on LAN; falling back to loopback only"
            );
        }
        crate::companion::start_daemon_server(daemon.clone(), port, false, listen_address).await?;
    }
    run_state::write(
        &daemon.roots,
        &run_state::DaemonRunState {
            port,
            pid: std::process::id(),
            version: DAEMON_VERSION.to_string(),
            managed_by,
            started_at: chrono::Utc::now().to_rfc3339(),
        },
    )?;
    info!(
        target: "daemon",
        "codemux-daemon listening on 127.0.0.1:{} (version={})",
        port,
        DAEMON_VERSION
    );

    let daemon_for_tick = daemon.clone();
    let tick_task = tokio::spawn(async move {
        loop {
            crate::scheduled_tasks::tick_async(&daemon_for_tick, chrono::Utc::now()).await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    wait_for_shutdown_signal().await;
    info!(target: "daemon", "Shutdown signal received; stopping companion server");

    tick_task.abort();
    crate::companion::stop_daemon_for_state(&daemon.companion).await?;
    run_state::clear(&daemon.roots);
    info!(target: "daemon", "codemux-daemon stopped cleanly");
    Ok(())
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = sigterm.recv() => {},
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::{DaemonState, NullUiEventSink, UiEventSink, WsUiEventSink};
    use crate::companion::state::CompanionBroadcastEvent;
    use crate::paths::PathRoots;
    use std::sync::Arc;

    #[test]
    fn assembles_full_core_without_shell_process() {
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

    #[test]
    fn ws_sink_broadcasts_ui_events_with_empty_session_id() {
        let companion = Arc::new(crate::companion::CompanionState::new());
        let sink = WsUiEventSink::new();
        sink.attach(companion.clone());
        let mut rx = companion.inner.event_tx.subscribe();

        sink.emit(
            "sessions-changed",
            serde_json::json!({ "sessionId": "s-1", "reason": "scheduled_task" }),
        );

        let received = rx
            .try_recv()
            .expect("ui event should reach the companion broadcast channel");
        let CompanionBroadcastEvent { session_id, event } = received;
        assert_eq!(session_id, "");
        assert_eq!(event["type"], "ui-event");
        assert_eq!(event["name"], "sessions-changed");
        assert_eq!(event["payload"]["sessionId"], "s-1");
    }

    #[test]
    fn ws_sink_before_attach_drops_events_silently() {
        let sink = WsUiEventSink::new();
        // 未 attach(未组装)时静默丢弃,不 panic —— 与 UiEventSink 契约一致。
        sink.emit(
            "scheduled-tasks-changed",
            serde_json::json!({ "taskIds": [] }),
        );
    }
}
