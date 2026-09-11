use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub turn_active: Mutex<HashSet<String>>,
    pub message_queues: Mutex<HashMap<String, VecDeque<QueuedCompanionMessage>>>,
    pub relay_controller: tokio::sync::Mutex<Option<RelayTransportController>>,
    pub relay_state: RelayTransportState,
    pub e2ee_public_key_b64: RwLock<Option<String>>,
    pub daemon_error: RwLock<Option<String>>,
    /// 浏览器自动化接缝(工单 08):挂起请求表 + 等待超时。
    pub browser_automation: crate::companion::browser_automation::AutomationRegistry,
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
            turn_active: Mutex::new(HashSet::new()),
            message_queues: Mutex::new(HashMap::new()),
            relay_controller: tokio::sync::Mutex::new(None),
            relay_state: RelayTransportState::new(),
            e2ee_public_key_b64: RwLock::new(None),
            daemon_error: RwLock::new(None),
            browser_automation: crate::companion::browser_automation::AutomationRegistry::new(),
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

    /// Backward-compatible alias: true when loopback daemon is listening.
    pub fn is_enabled(&self) -> bool {
        self.is_loopback_running()
    }

    pub fn clear_pairing_codes(&self) {
        self.pairing_codes.lock().unwrap().clear();
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

    pub fn mark_turn_active(&self, session_id: &str) {
        self.inner
            .turn_active
            .lock()
            .unwrap()
            .insert(session_id.to_string());
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
        self.inner.turn_active.lock().unwrap().remove(session_id);
        self.inner
            .message_queues
            .lock()
            .unwrap()
            .remove(session_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
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
}
