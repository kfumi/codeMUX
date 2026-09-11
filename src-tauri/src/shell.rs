//! 壳侧适配层:Tauri 应用环境与 daemon 注入根之间的转接。
//!
//! daemon 核心模块消费 [`PathRoots`],不接触 Tauri;本模块负责从壳构造
//! 注入根。本模块随 Tauri 壳生灭——独立 daemon(后续工单)改为从启动
//! 参数构造 PathRoots 后整体移除。

use crate::paths::PathRoots;
use tauri::AppHandle;

pub fn path_roots(app: &AppHandle) -> PathRoots {
    PathRoots::from_app(app).expect("Failed to get app data dir")
}

/// 把 Tauri 前端事件通道包装成 sidecar 事件出口。
pub struct IpcChannelSink {
    channel: tauri::ipc::Channel<String>,
}

impl IpcChannelSink {
    pub fn new(channel: tauri::ipc::Channel<String>) -> Self {
        Self { channel }
    }
}

impl crate::agent::sidecar_events::SidecarEventSink for IpcChannelSink {
    fn send(&self, event: String) {
        let _ = self.channel.send(event);
    }
}

/// daemon 领域事件 → Tauri 前端事件(tauri emit)。
pub struct TauriUiEventSink {
    app: AppHandle,
}

impl TauriUiEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl crate::daemon::UiEventSink for TauriUiEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }
}
