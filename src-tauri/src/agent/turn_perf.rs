//! [perf] 逐回合计时标记：量化「点击发送 → daemon 看到该回合首个 sidecar 事件」。
//!
//! 只记录日志、不改变任何行为。时间线上的其他节点（spawn/ready、ensure、
//! switchAgent、promptAsync、首个 delta）由各处既有的 `[perf]` 日志行覆盖，
//! 全部可以用 `[perf]` 前缀一次性 grep 出来。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

fn turns() -> &'static Mutex<HashMap<String, Instant>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock(
    map: &'static Mutex<HashMap<String, Instant>>,
) -> MutexGuard<'static, HashMap<String, Instant>> {
    map.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 记录一次消息发送的起点（同会话若已有未消费的起点则覆盖）。
pub fn mark_send(session_id: &str) {
    lock(turns()).insert(session_id.to_string(), Instant::now());
}

/// 取走该会话自 [`mark_send`] 以来的毫秒数；取一次即清空，保证每回合只记一次首事件。
pub fn take_elapsed_ms(session_id: &str) -> Option<u128> {
    lock(turns())
        .remove(session_id)
        .map(|start| start.elapsed().as_millis())
}

/// 丢弃该会话未消费的计时（回合异常结束/中断时防串味）。
pub fn clear(session_id: &str) {
    lock(turns()).remove(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_elapsed_returns_once_then_none() {
        let session_id = "test-session-once";
        clear(session_id);
        mark_send(session_id);
        let first = take_elapsed_ms(session_id).expect("first take should return elapsed");
        assert!(first < 60_000, "elapsed should be sane, got {first}ms");
        assert!(
            take_elapsed_ms(session_id).is_none(),
            "second take must be None (already consumed)"
        );
    }

    #[test]
    fn clear_drops_pending_mark() {
        let session_id = "test-session-clear";
        clear(session_id);
        mark_send(session_id);
        clear(session_id);
        assert!(take_elapsed_ms(session_id).is_none());
    }

    #[test]
    fn mark_send_overwrites_previous_mark() {
        let session_id = "test-session-overwrite";
        clear(session_id);
        mark_send(session_id);
        std::thread::sleep(std::time::Duration::from_millis(5));
        mark_send(session_id);
        let elapsed = take_elapsed_ms(session_id).expect("overwrite mark should be consumable");
        assert!(
            elapsed < 5,
            "elapsed should restart from the newer mark, got {elapsed}ms"
        );
        clear(session_id);
    }
}
