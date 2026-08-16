use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{broadcast, oneshot, RwLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionBroadcastEvent {
    pub session_id: String,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct PairingCodeEntry {
    pub expires_at: Instant,
}

pub struct CompanionInner {
    pub event_tx: broadcast::Sender<CompanionBroadcastEvent>,
    pub pairing_codes: Mutex<HashMap<String, PairingCodeEntry>>,
    pub shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    pub stopped_waiter: Mutex<Option<oneshot::Receiver<()>>>,
    pub lifecycle_lock: tokio::sync::Mutex<()>,
    pub port: RwLock<u16>,
    pub enabled: AtomicBool,
    pub turn_active: Mutex<HashSet<String>>,
    pub message_queues: Mutex<HashMap<String, VecDeque<String>>>,
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
            enabled: AtomicBool::new(false),
            turn_active: Mutex::new(HashSet::new()),
            message_queues: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
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
            expires_at: Instant::now() + Duration::from_secs(300),
        };
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Instant::now());
        codes.insert(code.clone(), entry);
        code
    }

    pub fn ensure_pairing_code(&self) -> String {
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Instant::now());
        if let Some(code) = codes.keys().next().cloned() {
            return code;
        }
        drop(codes);
        self.create_pairing_code()
    }

    pub fn refresh_pairing_code(&self) -> String {
        self.clear_pairing_codes();
        self.create_pairing_code()
    }

    pub fn consume_pairing_code(&self, code: &str) -> bool {
        let mut codes = self.inner.pairing_codes.lock().unwrap();
        codes.retain(|_, value| value.expires_at > Instant::now());
        if let Some(entry) = codes.remove(code) {
            return entry.expires_at > Instant::now();
        }
        false
    }

    pub fn clear_pairing_codes(&self) {
        self.inner.clear_pairing_codes();
    }

    pub fn mark_turn_active(&self, session_id: &str) {
        self.inner
            .turn_active
            .lock()
            .unwrap()
            .insert(session_id.to_string());
    }

    pub fn is_turn_active(&self, session_id: &str) -> bool {
        self.inner
            .turn_active
            .lock()
            .unwrap()
            .contains(session_id)
    }

    pub fn enqueue_message(&self, session_id: &str, prompt: String) {
        let mut queues = self.inner.message_queues.lock().unwrap();
        queues
            .entry(session_id.to_string())
            .or_default()
            .push_back(prompt);
    }

    pub fn finish_turn(&self, session_id: &str) -> Vec<String> {
        self.inner
            .turn_active
            .lock()
            .unwrap()
            .remove(session_id);
        self.inner
            .message_queues
            .lock()
            .unwrap()
            .remove(session_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }
}

impl Default for CompanionState {
    fn default() -> Self {
        Self::new()
    }
}
