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
    /// 电脑控制审批闸门(工单 03):挂起的人工放行 + 会话级只读记忆。
    pub approvals: crate::computer_use::guard::ApprovalRegistry,
    /// 快照喂给闸门的页面上下文(工单 03):URL/标题/元素敏感标记。
    pub page_context: crate::computer_use::page_context::PageContextCache,
    /// 电脑控制驱动宿主(工单 05/06):子进程句柄 + 急停信号。
    pub driver: crate::computer_use::driver::DriverHost,
    /// 步数护栏(工单 03/06):回合内的输入动作计数。
    pub step_budget: crate::computer_use::guard::StepBudget,
    /// 限时控制会话(工单 13):人工给出的输入授权,按 (会话, 回合) 记账。
    pub control_sessions: crate::computer_use::guard::ControlSessions,
    /// 回环浏览器简化配对(工单 02):同机浏览器的待确认配对请求表。
    pub local_pairing: crate::companion::local_pairing::LocalPairingRegistry,
    /// 界面订阅者计数(工单 19):键是**帧归属的那条流** —— 空串 = 控制面(壳收的
    /// 那条流),非空 = 某个会话的会话流,与 `handle_socket` / `handle_control_socket`
    /// 的分流一一对应。
    ///
    /// 「这条审批有没有界面能应答」只能看这个数,不能看广播通道有没有接收者 —— 壳的
    /// 控制面连接长期挂在通道上,却永远收不到(也不该收到)会话帧。
    pub ui_subscribers: Mutex<HashMap<String, usize>>,
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
            approvals: crate::computer_use::guard::ApprovalRegistry::new(),
            page_context: crate::computer_use::page_context::PageContextCache::new(),
            driver: crate::computer_use::driver::DriverHost::new(),
            step_budget: crate::computer_use::guard::StepBudget::new(),
            control_sessions: crate::computer_use::guard::ControlSessions::new(),
            local_pairing: crate::companion::local_pairing::LocalPairingRegistry::new(),
            ui_subscribers: Mutex::new(HashMap::new()),
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

impl CompanionInner {
    /// 某条流的订阅者 +1,返回「之前就已经有人订阅」。
    pub fn add_ui_subscriber(&self, channel: &str) -> bool {
        let mut subscribers = self.ui_subscribers.lock().expect("ui subscriber lock");
        let entry = subscribers.entry(channel.to_string()).or_insert(0);
        let was_watched = *entry > 0;
        *entry += 1;
        was_watched
    }

    /// 某条流的订阅者 -1,返回「这条流现在还有没有人订阅」。
    pub fn remove_ui_subscriber(&self, channel: &str) -> bool {
        let mut subscribers = self.ui_subscribers.lock().expect("ui subscriber lock");
        let Some(count) = subscribers.get_mut(channel) else {
            return false;
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            subscribers.remove(channel);
            return false;
        }
        true
    }

    /// 这条流现在有没有界面在订阅。
    pub fn has_ui_subscriber(&self, channel: &str) -> bool {
        self.ui_subscribers
            .lock()
            .expect("ui subscriber lock")
            .get(channel)
            .is_some_and(|count| *count > 0)
    }

    /// 系统里还有没有任何界面可能看到审批卡。
    ///
    /// 两种可能:有人正在看这条会话(请求帧直接送到它面前),或者有控制面客户端(桌面
    /// 壳在跑,用户可以打开这条会话看到卡片)。两者都没有 —— 比如定时任务/无人值守跑
    /// 在没开壳的机器上 —— 那这条放行请求谁也看不到,不必让模型干等满审批超时。
    pub fn has_approval_audience(&self, session_id: Option<&str>) -> bool {
        self.has_ui_subscriber("")
            || session_id.is_some_and(|session_id| self.has_ui_subscriber(session_id))
    }

    /// 系统里还有没有任何界面订阅着某条流(收尾时判断「审批卡已经无处可展示」)。
    pub fn has_any_ui(&self) -> bool {
        self.ui_subscribers
            .lock()
            .expect("ui subscriber lock")
            .values()
            .any(|count| *count > 0)
    }

    /// 界面全没了就把挂起的放行一起收掉(工单 19)。
    /// 没人能应答时让模型干等满审批超时是纯粹的浪费:收掉 sender 让等待端走既有的
    /// `dropped` 分支(文案「放行界面已断开」),fail closed。还有界面在看时不动作 ——
    /// 用户仍有机会来点放行。返回收掉了几条。
    pub async fn abandon_approvals_without_ui(&self) -> usize {
        if self.has_any_ui() {
            return 0;
        }
        self.approvals.abandon_all().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_subscribers_are_counted_per_connection() {
        // 审批的「有没有人能应答」只看这个计数(工单 19):两个界面看同一会话时,走掉一个
        // 不算「没人看了」;最后一个走了才算。
        let state = CompanionState::new();
        assert!(!state.inner.has_ui_subscriber("session-a"));
        assert!(!state.inner.has_approval_audience(Some("session-a")));
        assert!(!state.inner.has_approval_audience(None), "没有控制面客户端");

        assert!(!state.inner.add_ui_subscriber("session-a"), "第一个订阅者");
        assert!(state.inner.has_ui_subscriber("session-a"));
        assert!(state.inner.has_approval_audience(Some("session-a")));
        // 空串是控制面那条流:会话没人看,但有壳在跑 —— 用户还能打开会话看到卡片。
        assert!(!state.inner.has_approval_audience(None));
        assert!(!state.inner.add_ui_subscriber(""), "控制面客户端");
        assert!(state.inner.has_approval_audience(None));

        assert!(state.inner.add_ui_subscriber("session-a"), "第二个订阅者");
        assert!(state.inner.remove_ui_subscriber("session-a"), "还剩一个");
        assert!(state.inner.has_ui_subscriber("session-a"));

        assert!(
            !state.inner.remove_ui_subscriber("session-a"),
            "最后一个走了"
        );
        assert!(!state.inner.has_ui_subscriber("session-a"));
        assert!(
            state.inner.has_approval_audience(Some("session-a")),
            "壳还在跑:用户仍可打开这条会话放行"
        );
        assert!(!state.inner.remove_ui_subscriber(""), "控制面也走了");
        assert!(!state.inner.has_approval_audience(Some("session-a")));

        // 没人订阅时再摘一次不会把计数带成负数。
        assert!(!state.inner.remove_ui_subscriber("session-a"));
        assert!(!state.inner.has_ui_subscriber("session-b"));
    }

    #[tokio::test]
    async fn approvals_are_abandoned_only_when_the_last_ui_is_gone() {
        // 工单 19:界面全没了才把挂起的放行一起收掉 —— 还有界面在看时不能动手,用户
        // 仍有机会来点放行(「两分钟内过来放行」是既有能力)。
        let state = CompanionState::new();
        let waiting = state.inner.approvals.register("req-x").await;
        state.inner.add_ui_subscriber("");

        assert_eq!(
            state.inner.abandon_approvals_without_ui().await,
            0,
            "还有界面在看:不动手"
        );

        state.inner.remove_ui_subscriber("");
        assert_eq!(
            state.inner.abandon_approvals_without_ui().await,
            1,
            "最后一个界面走了:收掉挂起的放行"
        );
        assert!(
            waiting.await.is_err(),
            "等待端应收到通道关闭(走 dropped 分支)"
        );
        assert_eq!(
            state.inner.abandon_approvals_without_ui().await,
            0,
            "已经空了:再收一次是空操作"
        );
    }

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
