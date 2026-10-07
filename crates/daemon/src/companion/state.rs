use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::{broadcast, oneshot, RwLock};

use crate::companion::relay::{RelayTransportController, RelayTransportState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionBroadcastEvent {
    pub session_id: String,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct PairingCodeEntry {
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct QueuedCompanionMessage {
    pub prompt: String,
    pub input_payload: Option<serde_json::Value>,
}

pub struct CompanionInner {
    pub event_tx: broadcast::Sender<CompanionBroadcastEvent>,
    pub pairing_codes: Mutex<HashMap<String, PairingCodeEntry>>,
    pub shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    pub stopped_waiter: Mutex<Option<oneshot::Receiver<()>>>,
    pub lifecycle_lock: tokio::sync::Mutex<()>,
    pub port: RwLock<u16>,
    /// Loopback daemon is listening (always on after app start).
    pub loopback_running: AtomicBool,
    /// LAN / relay exposure enabled (user-facing "移动伴侣").
    pub lan_exposed: AtomicBool,
    /// 监听器代次:每次启动/停止监听都自增。旧监听器的收尾任务只在代次
    /// 仍然匹配时才清运行标志 —— 否则「开/关移动伴侣」触发重启时,正在
    /// 退出的旧任务会把新监听器的状态抹成「未运行」。
    pub server_generation: AtomicU64,
    pub turn_active: Mutex<HashSet<String>>,
    /// 每会话回合代次:`mark_turn_active` 自增并返回,供「派发 ack 看门狗」
    /// 区分自己武装的那一轮与之后的新回合。只增不清(否则清零后新回合的
    /// 代次会撞上旧看门狗武装的代次)。
    pub turn_epoch: Mutex<HashMap<String, u64>>,
    pub message_queues: Mutex<HashMap<String, VecDeque<QueuedCompanionMessage>>>,
    /// Subagent ids currently believed running per session, maintained from
    /// `subagent_upsert` broadcasts. Only used to arm the continuation wait.
    pub running_subagents: Mutex<HashMap<String, HashSet<String>>>,
    /// Sessions whose background subagents all went terminal and the parent's
    /// summary turn has not settled yet. Armed with a timestamp; the busy
    /// window expires so a lost summary turn can never stall the queue.
    pub continuation_pending: Mutex<HashMap<String, std::time::Instant>>,
    pub relay_controller: tokio::sync::Mutex<Option<RelayTransportController>>,
    pub relay_state: RelayTransportState,
    pub e2ee_public_key_b64: RwLock<Option<String>>,
    pub daemon_error: RwLock<Option<String>>,
    /// 浏览器自动化接缝(工单 08):挂起请求表 + 等待超时。
    pub browser_automation: crate::companion::browser_automation::AutomationRegistry,
    /// 回环浏览器简化配对(工单 02):同机浏览器的待确认配对请求表。
    pub local_pairing: crate::companion::local_pairing::LocalPairingRegistry,
}

impl CompanionInner {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        Self {
            event_tx,
            pairing_codes: Mutex::new(HashMap::new()),
            shutdown_tx: Mutex::new(None),
            stopped_waiter: Mutex::new(None),
            lifecycle_lock: tokio::sync::Mutex::new(()),
            port: RwLock::new(crate::config::types::CompanionConfig::default().port),
            loopback_running: AtomicBool::new(false),
            lan_exposed: AtomicBool::new(false),
            server_generation: AtomicU64::new(0),
            turn_active: Mutex::new(HashSet::new()),
            turn_epoch: Mutex::new(HashMap::new()),
            message_queues: Mutex::new(HashMap::new()),
            running_subagents: Mutex::new(HashMap::new()),
            continuation_pending: Mutex::new(HashMap::new()),
            relay_controller: tokio::sync::Mutex::new(None),
            relay_state: RelayTransportState::new(),
            e2ee_public_key_b64: RwLock::new(None),
            daemon_error: RwLock::new(None),
            browser_automation: crate::companion::browser_automation::AutomationRegistry::new(),
            local_pairing: crate::companion::local_pairing::LocalPairingRegistry::new(),
        }
    }

    pub fn is_loopback_running(&self) -> bool {
        self.loopback_running.load(Ordering::SeqCst)
    }

    pub fn set_loopback_running(&self, running: bool) {
        self.loopback_running.store(running, Ordering::SeqCst);
    }

    pub fn is_lan_exposed(&self) -> bool {
        self.lan_exposed.load(Ordering::SeqCst)
    }

    pub fn set_lan_exposed(&self, exposed: bool) {
        self.lan_exposed.store(exposed, Ordering::SeqCst);
    }

    /// 认领一代监听器:返回本代编号,供收尾任务判断自己是否仍是最新。
    pub fn claim_server_generation(&self) -> u64 {
        self.server_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current_server_generation(&self, generation: u64) -> bool {
        self.server_generation.load(Ordering::SeqCst) == generation
    }

    /// Backward-compatible alias: true when loopback daemon is listening.
    pub fn is_enabled(&self) -> bool {
        self.is_loopback_running()
    }

    pub fn clear_pairing_codes(&self) {
        self.pairing_codes.lock().unwrap().clear();
    }
}

impl Default for CompanionInner {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct CompanionState {
    pub inner: Arc<CompanionInner>,
}

impl CompanionState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CompanionInner::new()),
        }
    }

    pub fn create_pairing_code(&self) -> String {
        use rand::Rng;
        let code: String = (0..6)
            .map(|_| rand::thread_rng().gen_range(0..10).to_string())
            .collect();
        let entry = PairingCodeEntry {
            expires_at: Utc::now()
                + chrono::Duration::seconds(crate::companion::pairing_code::PAIRING_CODE_TTL_SECS),
        };
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Utc::now());
        codes.insert(code.clone(), entry);
        code
    }

    pub fn active_pairing_code(&self) -> Option<String> {
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Utc::now());
        codes.keys().next().cloned()
    }

    pub fn restore_pairing_code(&self, code: &str, expires_at: DateTime<Utc>) {
        if expires_at <= Utc::now() {
            return;
        }
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Utc::now());
        codes.insert(code.to_string(), PairingCodeEntry { expires_at });
    }

    pub fn ensure_pairing_code(&self) -> String {
        if let Some(code) = self.active_pairing_code() {
            return code;
        }
        self.create_pairing_code()
    }

    pub fn validate_pairing_code(&self, code: &str) -> bool {
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Utc::now());
        codes.contains_key(code)
    }

    pub fn clear_pairing_codes(&self) {
        self.inner.clear_pairing_codes();
    }

    pub fn relay_state(&self) -> RelayTransportState {
        self.inner.relay_state.clone()
    }

    pub async fn set_relay_controller(&self, controller: RelayTransportController) {
        let mut guard = self.inner.relay_controller.lock().await;
        *guard = Some(controller);
    }

    pub async fn take_relay_controller(&self) -> Option<RelayTransportController> {
        self.inner.relay_controller.lock().await.take()
    }

    pub async fn set_e2ee_public_key_b64(&self, value: String) {
        let mut guard = self.inner.e2ee_public_key_b64.write().await;
        *guard = Some(value);
    }

    pub async fn clear_e2ee_public_key(&self) {
        let mut guard = self.inner.e2ee_public_key_b64.write().await;
        *guard = None;
    }

    pub async fn e2ee_public_key_b64(&self) -> Option<String> {
        self.inner.e2ee_public_key_b64.read().await.clone()
    }

    /// 把运行态变化作为**显式 state 帧**广播给全部订阅方。
    ///
    /// 运行态帧必须是生产端显式广播,而不是订阅端(server.rs `handle_socket`)
    /// 在每个事件帧之后按 `is_turn_active` 探测派生:探测发生在订阅任务被唤醒
    /// 之后,翻转与帧的送达之间没有全局顺序保证,`state(running=false)` 可能被
    /// 插在终态事件帧**之前**(companion/events.rs 的顺序契约失去意义)。显式帧
    /// 与事件帧走同一条 event_tx 播放,逐连接保序。
    fn broadcast_turn_state(&self, session_id: &str, running: bool) {
        if !self.inner.is_enabled() {
            return;
        }
        let _ = self.inner.event_tx.send(CompanionBroadcastEvent {
            session_id: session_id.to_string(),
            event: serde_json::json!({
                "type": "state",
                "sessionId": session_id,
                "running": running,
            }),
        });
    }

    pub fn mark_turn_active(&self, session_id: &str) -> u64 {
        let inserted = self
            .inner
            .turn_active
            .lock()
            .unwrap()
            .insert(session_id.to_string());
        if inserted {
            self.broadcast_turn_state(session_id, true);
        }
        let mut epochs = self.inner.turn_epoch.lock().unwrap();
        let epoch = epochs.entry(session_id.to_string()).or_insert(0);
        *epoch += 1;
        *epoch
    }

    /// 当前回合代次;回合从未开始过(或本会话从未 mark)时为 None。
    pub fn turn_epoch(&self, session_id: &str) -> Option<u64> {
        self.inner
            .turn_epoch
            .lock()
            .unwrap()
            .get(session_id)
            .copied()
    }

    pub fn is_turn_active(&self, session_id: &str) -> bool {
        self.inner.turn_active.lock().unwrap().contains(session_id)
    }

    pub fn enqueue_message(
        &self,
        session_id: &str,
        prompt: String,
        input_payload: Option<serde_json::Value>,
    ) {
        let mut queues = self.inner.message_queues.lock().unwrap();
        queues
            .entry(session_id.to_string())
            .or_default()
            .push_back(QueuedCompanionMessage {
                prompt,
                input_payload,
            });
    }

    pub fn finish_turn(&self, session_id: &str) -> Vec<QueuedCompanionMessage> {
        let removed = self.inner.turn_active.lock().unwrap().remove(session_id);
        if removed {
            self.broadcast_turn_state(session_id, false);
        }
        self.clear_continuation_pending(session_id);
        self.inner
            .message_queues
            .lock()
            .unwrap()
            .remove(session_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    /// Track live subagent liveness from `subagent_upsert` broadcasts and arm
    /// the continuation wait when the last running child goes terminal: the
    /// parent is about to be woken for its summary turn, so the session is not
    /// settled even though no child is running anymore.
    pub fn apply_subagent_upsert(&self, session_id: &str, subagent_id: &str, status: &str) {
        const TERMINAL: [&str; 3] = ["completed", "failed", "canceled"];
        let mut running = self.inner.running_subagents.lock().unwrap();
        let session_running = running.entry(session_id.to_string()).or_default();
        if TERMINAL.contains(&status) {
            let was_running = session_running.remove(subagent_id);
            if session_running.is_empty() {
                running.remove(session_id);
                drop(running);
                if was_running && status == "completed" {
                    // 只有正常完成才等待汇总回合;失败/取消(用户停止、子智能体
                    // 挂掉)不会有汇总,继续算忙只会卡住队列。
                    self.inner
                        .continuation_pending
                        .lock()
                        .unwrap()
                        .insert(session_id.to_string(), std::time::Instant::now());
                }
            }
        } else {
            session_running.insert(subagent_id.to_string());
            self.inner
                .continuation_pending
                .lock()
                .unwrap()
                .remove(session_id);
        }
    }

    pub fn clear_continuation_pending(&self, session_id: &str) {
        self.inner
            .continuation_pending
            .lock()
            .unwrap()
            .remove(session_id);
    }

    /// True while the session's async flow is unsettled: a summary-turn wait
    /// armed within [`CONTINUATION_BUSY_WINDOW_SECS`]. A stale wait expires so
    /// a lost summary turn can never stall sends forever.
    pub fn is_continuation_pending(&self, session_id: &str) -> bool {
        const CONTINUATION_BUSY_WINDOW_SECS: u64 = 120;
        self.inner
            .continuation_pending
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|armed_at| {
                armed_at.elapsed() < std::time::Duration::from_secs(CONTINUATION_BUSY_WINDOW_SECS)
            })
    }

    pub async fn set_daemon_error(&self, error: Option<String>) {
        let mut guard = self.inner.daemon_error.write().await;
        *guard = error;
    }

    pub async fn daemon_error(&self) -> Option<String> {
        self.inner.daemon_error.read().await.clone()
    }
}

impl Default for CompanionState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_messages_while_turn_is_active() {
        let state = CompanionState::new();
        state.mark_turn_active("session-1");
        state.enqueue_message("session-1", "first".to_string(), None);
        state.enqueue_message("session-1", "second".to_string(), None);

        assert!(state.is_turn_active("session-1"));

        let drained = state.finish_turn("session-1");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].prompt, "first");
        assert_eq!(drained[1].prompt, "second");
        assert!(!state.is_turn_active("session-1"));
    }

    #[test]
    fn finish_turn_drains_queue_for_one_session_only() {
        let state = CompanionState::new();
        state.mark_turn_active("session-a");
        state.mark_turn_active("session-b");
        state.enqueue_message("session-a", "a1".to_string(), None);
        state.enqueue_message("session-b", "b1".to_string(), None);

        let drained_a = state.finish_turn("session-a");
        assert_eq!(drained_a.len(), 1);
        assert_eq!(drained_a[0].prompt, "a1");
        assert!(!state.is_turn_active("session-a"));
        assert!(state.is_turn_active("session-b"));

        let drained_b = state.finish_turn("session-b");
        assert_eq!(drained_b.len(), 1);
        assert_eq!(drained_b[0].prompt, "b1");
    }

    #[test]
    fn subagent_flow_tracking_arms_continuation_only_on_last_child_terminal() {
        let state = CompanionState::new();

        // Children running: not pending, a terminal sibling keeps it that way.
        state.apply_subagent_upsert("session-1", "toolu_1", "running");
        state.apply_subagent_upsert("session-1", "toolu_2", "running");
        assert!(!state.is_continuation_pending("session-1"));
        state.apply_subagent_upsert("session-1", "toolu_1", "completed");
        assert!(!state.is_continuation_pending("session-1"));

        // Last running child goes terminal: the summary turn is expected.
        state.apply_subagent_upsert("session-1", "toolu_2", "completed");
        assert!(state.is_continuation_pending("session-1"));

        // A new (or still running) child disarms the wait.
        state.apply_subagent_upsert("session-1", "toolu_3", "running");
        assert!(!state.is_continuation_pending("session-1"));
    }

    #[test]
    fn stale_terminal_upsert_for_unknown_child_does_not_arm_continuation() {
        let state = CompanionState::new();
        state.apply_subagent_upsert("session-1", "toolu_1", "completed");
        assert!(!state.is_continuation_pending("session-1"));
    }

    #[test]
    fn failed_children_do_not_arm_the_continuation_wait() {
        let state = CompanionState::new();
        state.apply_subagent_upsert("session-1", "toolu_1", "running");
        state.apply_subagent_upsert("session-1", "toolu_1", "failed");
        assert!(!state.is_continuation_pending("session-1"));
    }

    #[test]
    fn continuation_wait_expires_and_is_cleared_by_turn_boundaries() {
        let state = CompanionState::new();
        state.apply_subagent_upsert("session-1", "toolu_1", "running");
        state.apply_subagent_upsert("session-1", "toolu_1", "completed");
        assert!(state.is_continuation_pending("session-1"));

        // Backdate past the busy window: the wait must expire on its own so a
        // lost summary turn can never stall sends forever.
        {
            let mut pending = state.inner.continuation_pending.lock().unwrap();
            pending.insert(
                "session-1".to_string(),
                std::time::Instant::now() - std::time::Duration::from_secs(3600),
            );
        }
        assert!(!state.is_continuation_pending("session-1"));

        state.apply_subagent_upsert("session-1", "toolu_2", "running");
        state.apply_subagent_upsert("session-1", "toolu_2", "completed");
        assert!(state.is_continuation_pending("session-1"));
        state.clear_continuation_pending("session-1");
        assert!(!state.is_continuation_pending("session-1"));
    }

    #[test]
    fn finish_turn_clears_the_continuation_wait() {
        let state = CompanionState::new();
        state.mark_turn_active("session-1");
        state.apply_subagent_upsert("session-1", "toolu_1", "running");
        state.apply_subagent_upsert("session-1", "toolu_1", "completed");
        state.enqueue_message("session-1", "queued".to_string(), None);
        assert!(state.is_continuation_pending("session-1"));

        let drained = state.finish_turn("session-1");
        assert_eq!(drained.len(), 1);
        assert!(!state.is_continuation_pending("session-1"));
        assert!(!state.is_turn_active("session-1"));
    }

    #[test]
    fn loopback_running_is_independent_from_lan_exposure() {
        let inner = CompanionInner::new();
        inner.set_loopback_running(true);
        inner.set_lan_exposed(false);
        assert!(inner.is_loopback_running());
        assert!(!inner.is_lan_exposed());
        assert!(inner.is_enabled());

        inner.set_lan_exposed(true);
        assert!(inner.is_lan_exposed());
        assert!(inner.is_loopback_running());

        inner.set_loopback_running(false);
        assert!(!inner.is_loopback_running());
        assert!(!inner.is_enabled());
    }

    /// 开/关移动伴侣在请求内重启监听器:正在退出的旧监听器不得把新监听器
    /// 的运行标志抹掉,否则 UI 会一直停在「未开启」。
    #[test]
    fn stale_listener_generation_cannot_clear_live_flags() {
        let inner = CompanionInner::new();

        let first = inner.claim_server_generation();
        inner.set_loopback_running(true);
        inner.set_lan_exposed(true);

        // 第二代监听器已经接管(开关触发的重绑)。
        let second = inner.claim_server_generation();
        assert!(!inner.is_current_server_generation(first));
        assert!(inner.is_current_server_generation(second));

        // 旧监听器的收尾任务到这时才跑完 —— 它必须放手。
        if inner.is_current_server_generation(first) {
            inner.set_loopback_running(false);
            inner.set_lan_exposed(false);
        }
        assert!(inner.is_loopback_running(), "新监听器仍在运行");
        assert!(inner.is_lan_exposed(), "新监听器的暴露状态未被抹掉");
    }
}
