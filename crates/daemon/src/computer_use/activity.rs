//! 电脑控制活动真值(工单 01):「这台机器此刻正在被驱动」。
//!
//! 判据与工单 15 的渲染层口径同源:**本回合里出现过 `computer_*` 调用**就算在驱动,
//! 与这次动作最终有没有落地无关 —— 被审批拦下、无人应答、步数到顶、参数翻译失败的
//! 调用同样算「这个回合正在试图驱动桌面」。`browser_*` 是内置浏览器里的网页操作,
//! 不驱动桌面,不走这里。
//!
//! 这个模块只存**原始标记**,不判断「这个回合还算不算在跑」—— 那条判据属于
//! [`CompanionState`](crate::companion::state::CompanionState)(回合真值在它那里),
//! 由 [`ComputerUseActivity::snapshot_where`] 的谓词传进来。这样分工有两个好处:
//! 这里保持纯状态(好测、不加锁顺序风险),而「回合早就结束了却没人来清标记」这类
//! 陈旧残留会在下一次取快照时被自动剔掉,不会一直挂在状态里。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 一次会话的桌面活动标记。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActivityMark {
    /// 标记时所属的回合代次:代次前移即「新回合」,旧标记自动作废。
    pub epoch: u64,
    /// 本回合第一次试图驱动桌面的时刻(Unix 毫秒)。
    pub since_ms: u64,
    /// 标记时本回合已用掉的步数(诊断信息,不是判据)。
    pub steps: u32,
    /// 本回合是否有电脑控制审批挂着(界面据此说「正在等放行」)。
    pub awaiting_approval: bool,
}

/// 事件载荷里的一条会话明细。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySession {
    pub session_id: String,
    pub since_ms: u64,
    pub steps: u32,
    pub awaiting_approval: bool,
}

/// 事件载荷:整机是否正在被驱动 + 明细。
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub active: bool,
    pub sessions: Vec<ActivitySession>,
}

impl ActivitySnapshot {
    /// 当前有活动的会话 id(急停按这个列表打断回合)。
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .iter()
            .map(|session| session.session_id.clone())
            .collect()
    }
}

/// 活动标记表(进程内,不落库:daemon 重启即为空,不存在上一轮残留)。
#[derive(Debug, Default)]
pub struct ComputerUseActivity {
    marks: Mutex<HashMap<String, ActivityMark>>,
}

impl ComputerUseActivity {
    pub fn new() -> Self {
        Self::default()
    }

    /// 标记「这个回合试图驱动桌面」。
    ///
    /// 同一回合并重复调用只刷新步数;代次变了(新回合)则重新计时,不继承上一回合的
    /// 起始时间与待放行状态。
    pub fn mark(&self, session_id: &str, epoch: u64, steps: u32) {
        let mut marks = self.marks.lock().expect("activity lock");
        let since_ms = now_ms();
        marks
            .entry(session_id.to_string())
            .and_modify(|mark| {
                if mark.epoch == epoch {
                    mark.steps = steps;
                } else {
                    *mark = ActivityMark {
                        epoch,
                        since_ms,
                        steps,
                        awaiting_approval: false,
                    };
                }
            })
            .or_insert(ActivityMark {
                epoch,
                since_ms,
                steps,
                awaiting_approval: false,
            });
    }

    /// 审批挂起/离开。返回是否真的变了(没标记的会话不动)。
    pub fn set_awaiting_approval(&self, session_id: &str, awaiting: bool) -> bool {
        let mut marks = self.marks.lock().expect("activity lock");
        let Some(mark) = marks.get_mut(session_id) else {
            return false;
        };
        if mark.awaiting_approval == awaiting {
            return false;
        }
        mark.awaiting_approval = awaiting;
        true
    }

    /// 清掉一条会话的标记;返回是否真的清掉了。
    pub fn clear(&self, session_id: &str) -> bool {
        self.marks
            .lock()
            .expect("activity lock")
            .remove(session_id)
            .is_some()
    }

    /// 清空全部标记,返回清掉了几条。
    pub fn clear_all(&self) -> usize {
        let mut marks = self.marks.lock().expect("activity lock");
        let count = marks.len();
        marks.clear();
        count
    }

    /// 取快照:只保留 `is_current(会话, 代次)` 认可的标记,并顺手剔掉不认可的
    /// (回合已经不在跑、或代次已经前移的陈旧残留不会一直挂在状态里)。
    pub fn snapshot_where<F>(&self, is_current: F) -> ActivitySnapshot
    where
        F: Fn(&str, u64) -> bool,
    {
        let mut marks = self.marks.lock().expect("activity lock");
        marks.retain(|session_id, mark| is_current(session_id, mark.epoch));
        let mut sessions: Vec<ActivitySession> = marks
            .iter()
            .map(|(session_id, mark)| ActivitySession {
                session_id: session_id.clone(),
                since_ms: mark.since_ms,
                steps: mark.steps,
                awaiting_approval: mark.awaiting_approval,
            })
            .collect();
        // 顺序稳定:先按起始时间,再按会话 id(同一毫秒里多个会话时也有确定顺序)。
        sessions.sort_by(|left, right| {
            left.since_ms
                .cmp(&right.since_ms)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        ActivitySnapshot {
            active: !sessions.is_empty(),
            sessions,
        }
    }

    /// 不做回合过滤的原始快照(诊断与测试用)。
    pub fn snapshot(&self) -> ActivitySnapshot {
        self.snapshot_where(|_, _| true)
    }

    /// 现在有没有标记(不论回合状态)。
    pub fn is_marked(&self, session_id: &str) -> bool {
        self.marks
            .lock()
            .expect("activity lock")
            .contains_key(session_id)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marking_records_the_turn_and_the_step_count() {
        let activity = ComputerUseActivity::new();
        assert!(!activity.snapshot().active, "新表是空的(进程重启即空)");

        activity.mark("session-a", 1, 0);
        activity.mark("session-a", 1, 3);
        let snapshot = activity.snapshot();
        assert!(snapshot.active);
        assert_eq!(snapshot.sessions.len(), 1, "同一回合并重复标记只有一条");
        assert_eq!(snapshot.sessions[0].steps, 3, "步数刷新到最新");
    }

    #[test]
    fn a_new_turn_restarts_the_clock_and_the_approval_flag() {
        let activity = ComputerUseActivity::new();
        activity.mark("session-a", 1, 2);
        assert!(activity.set_awaiting_approval("session-a", true));
        let first = activity.snapshot().sessions[0].since_ms;

        // 代次前移 = 新回合:起始时间重新计时,待放行状态不继承。
        activity.mark("session-a", 2, 0);
        let second = activity.snapshot().sessions[0].clone();
        assert_eq!(second.steps, 0);
        assert!(!second.awaiting_approval, "新回合不继承上一回合的待放行");
        assert!(second.since_ms >= first);
    }

    #[test]
    fn snapshot_only_keeps_turns_the_caller_still_considers_current() {
        let activity = ComputerUseActivity::new();
        activity.mark("running", 1, 0);
        activity.mark("finished", 1, 0);
        activity.mark("stale-epoch", 1, 0);

        let snapshot = activity.snapshot_where(|session_id, epoch| match session_id {
            "running" => epoch == 1,
            "stale-epoch" => epoch == 2,
            _ => false,
        });
        assert_eq!(snapshot.session_ids(), vec!["running".to_string()]);
        // 不够格的标记被剔掉了,不会一直挂着。
        assert!(!activity.is_marked("finished"));
        assert!(!activity.is_marked("stale-epoch"));
        assert!(activity.is_marked("running"));
    }

    #[test]
    fn clearing_is_per_session_and_idempotent() {
        let activity = ComputerUseActivity::new();
        activity.mark("session-a", 1, 0);
        activity.mark("session-b", 1, 0);
        assert!(activity.clear("session-a"));
        assert!(!activity.clear("session-a"), "清两次只有第一次算数");
        assert_eq!(
            activity.snapshot().session_ids(),
            vec!["session-b".to_string()]
        );
        assert_eq!(activity.clear_all(), 1);
        assert!(!activity.snapshot().active);
    }

    #[test]
    fn the_approval_flag_only_tracks_marked_sessions() {
        let activity = ComputerUseActivity::new();
        assert!(
            !activity.set_awaiting_approval("unmarked", true),
            "没标记的会话不动(标记代表「本回合试图驱动过桌面」)"
        );
        activity.mark("session-a", 1, 0);
        assert!(activity.set_awaiting_approval("session-a", true));
        assert!(
            !activity.set_awaiting_approval("session-a", true),
            "状态没变就不是变化"
        );
        assert!(activity.snapshot().sessions[0].awaiting_approval);
    }
}
