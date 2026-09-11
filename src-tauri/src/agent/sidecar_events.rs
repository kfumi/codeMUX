//! Sidecar 事件投递的进程内抽象。
//!
//! daemon 核心只把原始 JSON 行交给 [`SidecarEventBinding`],事件去向由壳侧
//! 决定(Tauri IPC Channel,见 `shell::IpcChannelSink`)。未绑定或绑定了
//! [`NullSidecarSink`] 时事件被丢弃,对应附件增强、历史清理等一次性辅助
//! sidecar:它们的事件只在本模块内的等待器/解析路径消费,不需要前端投递。

use std::sync::Arc;
use tokio::sync::Mutex;

pub trait SidecarEventSink: Send + Sync + 'static {
    /// 投递一条原始事件行。失败静默,与原 Tauri Channel 的调用侧行为一致。
    fn send(&self, event: String);
}

/// 可重绑定的单播事件出口:sidecar 被复用到新的交互会话时,壳重新 bind,
/// 后续事件改投新的前端通道;未绑定期间事件不投递(持久化与 companion
/// 扇出仍照常,发生在 binding 之前)。
#[derive(Clone, Default)]
pub struct SidecarEventBinding {
    sink: Arc<Mutex<Option<Arc<dyn SidecarEventSink>>>>,
}

impl SidecarEventBinding {
    pub fn unbound() -> Self {
        Self::default()
    }

    pub async fn bind(&self, sink: Arc<dyn SidecarEventSink>) {
        *self.sink.lock().await = Some(sink);
    }

    pub async fn send(&self, event: String) {
        let sink = self.sink.lock().await.clone();
        if let Some(sink) = sink {
            sink.send(event);
        }
    }
}

/// 丢弃一切事件的 sink。
pub struct NullSidecarSink;

impl SidecarEventSink for NullSidecarSink {
    fn send(&self, _event: String) {}
}

pub fn null_sink() -> Arc<dyn SidecarEventSink> {
    Arc::new(NullSidecarSink)
}

#[cfg(test)]
mod tests {
    use super::{SidecarEventBinding, SidecarEventSink};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Mutex as AsyncMutex;

    #[derive(Default)]
    struct RecordingSink {
        events: AsyncMutex<Vec<String>>,
    }

    impl SidecarEventSink for RecordingSink {
        fn send(&self, event: String) {
            if let Ok(mut events) = self.events.try_lock() {
                events.push(event);
            }
        }
    }

    async fn recorded(sink: &RecordingSink) -> Vec<String> {
        sink.events.lock().await.clone()
    }

    #[tokio::test]
    async fn unbound_binding_buffers_nothing_before_bind() {
        let binding = SidecarEventBinding::unbound();
        binding.send("early".to_string()).await;

        let sink = Arc::new(RecordingSink::default());
        binding.bind(sink.clone()).await;
        binding.send("late".to_string()).await;

        assert_eq!(
            recorded(&sink).await,
            vec!["late".to_string()],
            "events sent while unbound must not be replayed after binding"
        );
    }

    #[tokio::test]
    async fn bound_binding_delivers_and_rebind_switches_target() {
        let binding = SidecarEventBinding::unbound();
        let first = Arc::new(RecordingSink::default());
        let second = Arc::new(RecordingSink::default());

        binding.bind(first.clone()).await;
        binding.send("one".to_string()).await;

        binding.bind(second.clone()).await;
        binding.send("two".to_string()).await;

        assert_eq!(recorded(&first).await, vec!["one".to_string()]);
        assert_eq!(recorded(&second).await, vec!["two".to_string()]);
    }

    #[tokio::test]
    async fn send_is_noop_after_binding_replaced_by_clear() {
        static DROPPED: AtomicUsize = AtomicUsize::new(0);
        struct CountingSink;
        impl SidecarEventSink for CountingSink {
            fn send(&self, _event: String) {
                DROPPED.fetch_add(1, Ordering::SeqCst);
            }
        }

        let binding = SidecarEventBinding::unbound();
        binding.bind(Arc::new(CountingSink)).await;
        binding.send("a".to_string()).await;
        binding.bind(super::null_sink()).await;
        binding.send("b".to_string()).await;

        assert_eq!(DROPPED.load(Ordering::SeqCst), 1);
    }
}
