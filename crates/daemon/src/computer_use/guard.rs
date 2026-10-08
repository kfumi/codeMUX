//! 电脑控制审批策略(工单 03):风险分级、敏感场景识别与粒度决策。
//!
//! 分权模型(需求 18、21、23):
//!
//! - **只读**(快照、截图、窗口列表)走轻量确认,可「按会话记住」;
//! - **输入**(点击、输入、滚动、选择,以及任意 JS/CDP)一次一放行,
//!   「记住」不生效;
//! - **敏感场景**(登录、支付、验证码、密码、删除、关闭防护)强制人工确认,
//!   会话记忆一律不命中。
//!
//! 「输入动作在任何权限模式下都不豁免」在类型上就成立:[`decide`] 没有接收
//! 权限档位的入参,调用方无法用 full_access/bypass 之类的东西换到放行。
//! 本模块全部是纯函数,便于行列式测试。

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::Duration;

use tokio::sync::{oneshot, Mutex};

/// 人工放行的等待上限:超时按拒绝收口(fail closed)。
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 操作的风险级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskClass {
    /// 只读观测:看页面/看桌面,不改动任何东西。
    ReadOnly,
    /// 输入动作:会改变页面或系统状态。
    Input,
}

/// 只读操作集合(其余一切按输入动作收口,含没见过的 op)。
pub const READ_ONLY_OPS: [&str; 7] = [
    "list",
    "snapshot",
    "screenshot",
    "desktop-windows",
    "desktop-screenshot",
    "desktop-active-window",
    "driver-status",
];

/// 敏感场景触发词表:`(匹配词, 面向用户的中文场景名)`。
///
/// ASCII 词按词边界匹配(避免 `pay` 命中 `payload`),中文按子串匹配。
const SENSITIVE_TRIGGERS: &[(&str, &str)] = &[
    ("登录", "登录"),
    ("login", "登录"),
    ("signin", "登录"),
    ("sign in", "登录"),
    ("支付", "支付"),
    ("付款", "支付"),
    ("payment", "支付"),
    ("checkout", "支付"),
    ("验证码", "验证码"),
    ("captcha", "验证码"),
    ("密码", "密码"),
    ("password", "密码"),
    ("passwd", "密码"),
    ("credential", "密码"),
    ("删除", "删除"),
    ("delete", "删除"),
    ("unlink", "删除"),
    ("关闭防护", "关闭防护"),
    ("firewall", "关闭防护"),
    ("antivirus", "关闭防护"),
    ("defender", "关闭防护"),
    ("安全中心", "关闭防护"),
];

/// 风险分级:只有明确列进 [`READ_ONLY_OPS`] 的操作算只读。
pub fn classify(op: &str) -> RiskClass {
    if READ_ONLY_OPS.contains(&op) {
        RiskClass::ReadOnly
    } else {
        RiskClass::Input
    }
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// 关键词命中:ASCII 要求词边界,中文按子串。
fn keyword_hit(haystack: &str, needle: &str) -> bool {
    if !needle.is_ascii() {
        return haystack.contains(needle);
    }
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(offset) = haystack[from..].find(needle) {
        let start = from + offset;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// 一段文本是否命中敏感场景;命中时返回场景名。
pub fn sensitive_trigger(text: &str) -> Option<&'static str> {
    let lowered = text.to_lowercase();
    SENSITIVE_TRIGGERS
        .iter()
        .find(|(needle, _)| keyword_hit(&lowered, needle))
        .map(|(_, label)| *label)
}

/// 汇总一次调用的判定文本(命中即敏感):工具名、op、参数值、页面上下文。
pub fn sensitivity_of(parts: &[&str]) -> Option<&'static str> {
    parts.iter().find_map(|part| sensitive_trigger(part))
}

/// 闸门判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    /// 无需人工介入(只读且本会话已记住)。
    Auto,
    /// 需要人工放行;`rememberable` 为真时界面才提供「本会话记住」。
    Ask { rememberable: bool },
}

/// 粒度决策。注意入参里没有权限档位 —— 输入动作与敏感场景的「必须人工
/// 放行」不是靠校验某个模式实现的,而是无处可传,调用方换不到豁免。
pub fn decide(
    class: RiskClass,
    sensitive: Option<&str>,
    remembered_for_session: bool,
) -> GateDecision {
    if sensitive.is_some() {
        // 敏感场景每一步都要人在当下确认,连只读的会话记忆也不认。
        return GateDecision::Ask {
            rememberable: false,
        };
    }
    match class {
        RiskClass::ReadOnly if remembered_for_session => GateDecision::Auto,
        RiskClass::ReadOnly => GateDecision::Ask { rememberable: true },
        RiskClass::Input => GateDecision::Ask {
            rememberable: false,
        },
    }
}

/// 会话记忆键:同一会话内记住的是「哪一类只读操作」,不是某一次调用。
pub fn session_memory_key(op: &str) -> String {
    format!("read-only:{op}")
}

/// 人工决策(与既有审批界面同一套词:单步放行 / 按会话记住 / 拦截)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalChoice {
    Once,
    Always,
    Reject,
}

impl ApprovalChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalChoice::Once => "once",
            ApprovalChoice::Always => "always",
            ApprovalChoice::Reject => "reject",
        }
    }
}

/// 步数护栏(需求 22):一次回合里的**输入动作**计数,到顶就停。
///
/// 只数输入动作:只读观测看一百次也不会失控,而输入动作每个都要人放行 ——
/// 上限管的是「这一步还要不要继续动」,不是「还能看几眼」。
///
/// 回合边界按 `turn_epoch` 重置:用户发新消息即新一轮预算。
#[derive(Default)]
pub struct StepBudget {
    /// session_id → (回合代次, 本回合已用步数)。
    counts: RwLock<HashMap<String, (u64, u32)>>,
}

impl StepBudget {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记一步并判断是否超限;`max_steps` 为 0 视为不限。
    ///
    /// 返回 `Err(used)`:本回合已用步数(含这一步),调用方据此出拒绝文案。
    pub fn charge(&self, session_id: &str, turn_epoch: u64, max_steps: u32) -> Result<u32, u32> {
        if max_steps == 0 {
            return Ok(0);
        }
        let mut counts = self.counts.write().expect("step budget lock");
        let entry = counts
            .entry(session_id.to_string())
            .or_insert((turn_epoch, 0));
        if entry.0 != turn_epoch {
            // 新回合:预算重置。
            *entry = (turn_epoch, 0);
        }
        entry.1 += 1;
        if entry.1 > max_steps {
            Err(entry.1)
        } else {
            Ok(entry.1)
        }
    }

    /// 当前回合已用步数(老回合的计数不算数)。
    pub fn used_in_turn(&self, session_id: &str, turn_epoch: u64) -> u32 {
        self.counts
            .read()
            .expect("step budget lock")
            .get(session_id)
            .filter(|(epoch, _)| *epoch == turn_epoch)
            .map(|(_, used)| *used)
            .unwrap_or(0)
    }

    /// 当前已用步数(UI/诊断用,不问回合)。
    pub fn used(&self, session_id: &str) -> u32 {
        self.counts
            .read()
            .expect("step budget lock")
            .get(session_id)
            .map(|(_, used)| *used)
            .unwrap_or(0)
    }
}

/// 挂起的人工审批表 + 会话级只读记忆。
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalChoice>>>,
    session_memory: RwLock<HashMap<String, HashSet<String>>>,
    timeout: RwLock<Duration>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            session_memory: RwLock::new(HashMap::new()),
            timeout: RwLock::new(APPROVAL_TIMEOUT),
        }
    }

    pub fn timeout(&self) -> Duration {
        *self.timeout.read().expect("approval timeout lock")
    }

    /// 测试缝:缩短等待超时(生产固定 [`APPROVAL_TIMEOUT`])。
    pub fn set_timeout(&self, timeout: Duration) {
        *self.timeout.write().expect("approval timeout lock") = timeout;
    }

    pub async fn register(&self, request_id: &str) -> oneshot::Receiver<ApprovalChoice> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.to_string(), tx);
        rx
    }

    /// 回填人工决策;requestId 未知(超时清理或从未存在)返回 false。
    pub async fn resolve(&self, request_id: &str, choice: ApprovalChoice) -> bool {
        match self.pending.lock().await.remove(request_id) {
            Some(sender) => sender.send(choice).is_ok(),
            None => false,
        }
    }

    pub async fn abandon(&self, request_id: &str) {
        self.pending.lock().await.remove(request_id);
    }

    /// 记下「本会话记住」的只读操作键。
    pub fn remember_for_session(&self, session_id: &str, key: &str) {
        self.session_memory
            .write()
            .expect("approval memory lock")
            .entry(session_id.to_string())
            .or_default()
            .insert(key.to_string());
    }

    pub fn is_remembered(&self, session_id: &str, key: &str) -> bool {
        self.session_memory
            .read()
            .expect("approval memory lock")
            .get(session_id)
            .is_some_and(|keys| keys.contains(key))
    }

    /// 忘记某个会话的只读记忆(会话级撤销;目前只有测试用它,
    /// 生产路径靠会话结束即失效 —— 记忆本来就只活在进程内存里)。
    pub fn forget_session(&self, session_id: &str) {
        self.session_memory
            .write()
            .expect("approval memory lock")
            .remove(session_id);
    }
}

impl Default for ApprovalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 需要审批的所有权限档位 —— 逐档跑同一断言,证明「输入不豁免」不是
    /// 靠某个档位特判实现的。
    const PERMISSION_MODES: [&str; 6] = [
        "default",
        "acceptEdits",
        "auto",
        "dontAsk",
        "bypassPermissions",
        "full_access",
    ];

    #[test]
    fn read_only_ops_are_classified_read_only() {
        for op in [
            "list",
            "snapshot",
            "screenshot",
            "desktop-windows",
            "desktop-screenshot",
            "desktop-active-window",
        ] {
            assert_eq!(classify(op), RiskClass::ReadOnly, "{op} 应为只读");
        }
    }

    #[test]
    fn input_and_unknown_ops_are_classified_input() {
        for op in [
            "click",
            "type",
            "scroll",
            "select",
            "input",
            "eval",
            "cdp",
            "driver-click",
            "",
        ] {
            assert_eq!(classify(op), RiskClass::Input, "{op} 应为输入动作");
        }
    }

    #[test]
    fn ascii_keywords_require_word_boundaries() {
        assert_eq!(
            sensitive_trigger("https://shop.example.com/pay/checkout"),
            Some("支付")
        );
        // payload 里含 pay,但不是支付场景。
        assert_eq!(sensitive_trigger(r#"{"payload":{"bytes":12}}"#), None);
        // login 命中,loginCount 不命中。
        assert_eq!(sensitive_trigger("signin required"), Some("登录"));
        assert_eq!(sensitive_trigger("loginCount=3"), None);
    }

    #[test]
    fn chinese_keywords_match_by_substring() {
        assert_eq!(sensitive_trigger("请在此处输入登录密码"), Some("登录"));
        assert_eq!(sensitive_trigger("删除这条记录"), Some("删除"));
        assert_eq!(
            sensitive_trigger("关闭 Windows Defender 实时防护"),
            Some("关闭防护")
        );
        assert_eq!(sensitive_trigger("https://example.com/dashboard"), None);
    }

    #[test]
    fn sensitivity_scan_covers_all_supplied_parts() {
        assert_eq!(sensitivity_of(&["browser_click", "click", "e3"]), None);
        assert_eq!(
            sensitivity_of(&["browser_type", "type", "支付确认页"]),
            Some("支付")
        );
    }

    #[test]
    fn read_only_is_rememberable_but_input_is_not() {
        assert_eq!(
            decide(RiskClass::ReadOnly, None, false),
            GateDecision::Ask { rememberable: true }
        );
        assert_eq!(decide(RiskClass::ReadOnly, None, true), GateDecision::Auto);
        assert_eq!(
            decide(RiskClass::Input, None, true),
            GateDecision::Ask {
                rememberable: false
            },
            "输入动作即便本会话「记住」过也必须再问一次"
        );
    }

    #[test]
    fn sensitive_scenarios_never_honour_session_memory() {
        assert_eq!(
            decide(RiskClass::ReadOnly, Some("密码"), true),
            GateDecision::Ask {
                rememberable: false
            }
        );
        assert_eq!(
            decide(RiskClass::Input, Some("支付"), true),
            GateDecision::Ask {
                rememberable: false
            }
        );
    }

    #[test]
    fn input_actions_are_not_exempted_in_any_permission_mode() {
        for mode in PERMISSION_MODES {
            // 权限档位不是 decide 的入参:这里按「最宽松」的场景构造输入动作
            // (本会话已记住),任何档位下都必须仍然是 Ask。
            let decision = decide(RiskClass::Input, None, true);
            assert_eq!(
                decision,
                GateDecision::Ask {
                    rememberable: false
                },
                "{mode} 下输入动作仍须人工放行"
            );
        }
    }

    #[test]
    fn session_memory_key_is_op_scoped() {
        assert_eq!(session_memory_key("snapshot"), "read-only:snapshot");
        assert_ne!(
            session_memory_key("snapshot"),
            session_memory_key("screenshot")
        );
    }

    #[tokio::test]
    async fn registry_resolves_and_forgets() {
        let registry = ApprovalRegistry::new();
        assert_eq!(registry.timeout(), APPROVAL_TIMEOUT);
        registry.set_timeout(Duration::from_millis(50));
        assert_eq!(registry.timeout(), Duration::from_millis(50));

        let rx = registry.register("req-1").await;
        assert!(!registry.resolve("unknown", ApprovalChoice::Once).await);
        assert!(registry.resolve("req-1", ApprovalChoice::Once).await);
        assert_eq!(rx.await.expect("oneshot 应被唤醒"), ApprovalChoice::Once);

        let rx = registry.register("req-2").await;
        registry.abandon("req-2").await;
        assert!(rx.await.is_err(), "abandon 后等待端应收到通道关闭");
    }

    #[tokio::test]
    async fn session_memory_is_scoped_per_session() {
        let registry = ApprovalRegistry::new();
        registry.remember_for_session("session-a", "read-only:snapshot");
        assert!(registry.is_remembered("session-a", "read-only:snapshot"));
        assert!(!registry.is_remembered("session-b", "read-only:snapshot"));
        assert!(!registry.is_remembered("session-a", "read-only:screenshot"));

        registry.forget_session("session-a");
        assert!(!registry.is_remembered("session-a", "read-only:snapshot"));
    }

    #[test]
    fn step_budget_stops_at_the_limit_and_resets_per_turn() {
        let budget = StepBudget::new();
        // 回合 7:上限 3,前三步放行,第四步拒绝。
        assert_eq!(budget.charge("s1", 7, 3), Ok(1));
        assert_eq!(budget.charge("s1", 7, 3), Ok(2));
        assert_eq!(budget.charge("s1", 7, 3), Ok(3));
        assert_eq!(budget.charge("s1", 7, 3), Err(4), "到顶必须停下");
        assert_eq!(budget.used("s1"), 4);
        assert_eq!(
            budget.used_in_turn("s1", 8),
            0,
            "老回合的计数不算在新回合头上"
        );

        // 新回合(用户发了新消息):预算重置。
        assert_eq!(budget.charge("s1", 8, 3), Ok(1));
        // 别的会话各自计数。
        assert_eq!(budget.charge("s2", 8, 3), Ok(1));
        assert_eq!(budget.used("s2"), 1);
    }

    #[test]
    fn step_budget_zero_means_unlimited() {
        let budget = StepBudget::new();
        for _ in 0..500 {
            assert_eq!(budget.charge("s1", 1, 0), Ok(0));
        }
    }

    #[test]
    fn approval_choices_serialize_to_ui_vocabulary() {
        assert_eq!(
            serde_json::to_string(&ApprovalChoice::Always).unwrap(),
            "\"always\""
        );
        let parsed: ApprovalChoice = serde_json::from_str("\"reject\"").unwrap();
        assert_eq!(parsed, ApprovalChoice::Reject);
        assert_eq!(ApprovalChoice::Once.as_str(), "once");
    }
}
