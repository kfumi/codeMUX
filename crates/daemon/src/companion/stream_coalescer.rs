use serde_json::Value;
use uuid::Uuid;

/// WS 广播腿的 delta 合批器(最后一跳)。
///
/// sidecar 传输层已把 delta 按 50ms 批成 `codemux_event_batch`,但 daemon 此前
/// 把每一批重新拆成「一条 delta 一帧 WS 消息」广播给所有客户端。delta 在持久化
/// 盖章时被剥掉 sequence(timeline_persist 的约束:流式 delta 不携带快照序列),
/// 客户端又只按 `(type, index)` 纯追加文本——因此把同键连续 delta 合并成一条
/// 更大的 delta,下游**不可分辨**,却能把 WS 帧数从「每 delta 一帧」压到
/// 「每批至多每流一帧」,对所有客户端(桌面/浏览器/移动/CLI)同时生效。
///
/// 保序不变量(与 sidecar 传输层的 flush-before-semantic 一致):语义事件发出前,
/// 先冲出逻辑上先于它的挂起 delta,delta 永不被语义事件"超车"。
///
/// 合批器**无跨批状态**:每次 `handle_sidecar_event_for_companion` 调用结束时
/// flush,不加延迟;窗口由上游 sidecar 的 50ms 批次天然界定。
///
/// **子智能体时间线**:子智能体帧(`subagent_timeline`)把 delta 包在 `event` 里,且
/// sidecar 不对它们做批(见 `streamEventBatcher` —— 它的可批类型只认顶层 delta),所以
/// 之前是「每 delta 一帧」。这里按 `(子智能体, 类型, index)` 合流:同一会话里多个子智能体
/// 并行,不同子智能体的同号 `index` 不是同一条流,必须分开。合并只动广播腿,落库仍是
/// 合帧前的每一条,所以重连时从 `GET /sessions/:id/subagents` 拉回的���史依旧完整。
pub struct DeltaCoalescer {
    pending: Option<PendingDelta>,
}

impl Default for DeltaCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl DeltaCoalescer {
    pub fn new() -> Self {
        Self { pending: None }
    }

    /// 输入一个原始广播事件,返回此刻应当发出的帧(0 个 = 被合并;1-2 个 =
    /// 冲出的挂起 delta 与/或事件本身)。非 delta 事件原样透传。
    pub fn push(&mut self, event: Value) -> Vec<Value> {
        if let Some(pending) = self.pending.as_mut() {
            if pending.matches(&event) {
                pending.absorb(&event);
                return Vec::new();
            }
        }

        let mut frames = Vec::with_capacity(2);
        if let Some(pending) = self.pending.take() {
            frames.push(pending.merged);
        }
        match PendingDelta::new(&event) {
            Some(pending) => self.pending = Some(pending),
            None => frames.push(event),
        }
        frames
    }

    /// 冲出挂起的合并 delta(每批结束时调用)。
    pub fn flush(&mut self) -> Vec<Value> {
        self.pending
            .take()
            .map(|pending| vec![pending.merged])
            .unwrap_or_default()
    }
}

/// 一条挂起的合并流:同一 `(类型, 会话, 子智能体, index)` 的连续 delta。
/// 身份字段( event_id/timestamp 等)取首条,载荷字符串做拼接。
struct PendingDelta {
    session_id: String,
    /// 子智能体帧额外按 `subagent_id` 分流:同一会话里多个子智能体并行,不同子智能体
    /// 的同号 `index` 不是同一条流。
    subagent_id: Option<String>,
    event_type: String,
    index: Value,
    site: PayloadSite,
    merged: Value,
}

/// delta 载荷在帧里的位置:父时间线帧就是帧本身,子智能体帧把它包在 `event` 里。
#[derive(Clone, Copy, PartialEq, Eq)]
enum PayloadSite {
    TopLevel,
    Nested,
}

impl PendingDelta {
    fn new(event: &Value) -> Option<Self> {
        let session_id = event.get("session_id")?.as_str()?.to_string();
        let (site, body, subagent_id) = match event.get("type").and_then(Value::as_str) {
            Some("subagent_timeline") => (
                PayloadSite::Nested,
                event.get("event")?,
                Some(event.get("subagent_id")?.as_str()?.to_string()),
            ),
            _ => (PayloadSite::TopLevel, event, None),
        };
        let event_type = body.get("type")?.as_str()?;
        let field = payload_field(event_type)?;
        let index = body.get("index")?.clone();
        // 首条载荷必须是字符串;畸形事件原样透传,不参与合并。
        payload_as_str(event, site, field)?;
        Some(Self {
            session_id,
            subagent_id,
            event_type: event_type.to_string(),
            index,
            site,
            merged: event.clone(),
        })
    }

    fn matches(&self, event: &Value) -> bool {
        let Some(field) = payload_field(&self.event_type) else {
            return false;
        };
        if self.site != site_of(event) {
            return false;
        }
        let body = match self.site {
            PayloadSite::TopLevel => event,
            PayloadSite::Nested => match event.get("event") {
                Some(body) => body,
                None => return false,
            },
        };
        let other_subagent_id = match self.site {
            PayloadSite::TopLevel => None,
            PayloadSite::Nested => event.get("subagent_id").and_then(Value::as_str),
        };
        body.get("type").and_then(Value::as_str) == Some(self.event_type.as_str())
            && event.get("session_id").and_then(Value::as_str) == Some(self.session_id.as_str())
            && other_subagent_id == self.subagent_id.as_deref()
            && body.get("index") == Some(&self.index)
            && payload_as_str(event, self.site, field).is_some()
    }

    fn absorb(&mut self, event: &Value) {
        let Some(field) = payload_field(&self.event_type) else {
            return;
        };
        let Some(src) = payload_as_str(event, self.site, field) else {
            return;
        };
        if let Some(dst) = payload_str_mut(&mut self.merged, self.site, field) {
            dst.push_str(src);
        }
        // 合并帧是一条**新的**投递，必须换 `event_id`。
        //
        // 父时间线的客户端按 `sequence` 去重而 delta 不带 sequence,换不换无所谓;但
        // 子智能体帧不同——`subagentStore.appendEvent` 恰恰按 `event_id` 去重,而
        // 落库时合帧前的每条 delta 都已各自持久化。若沿用首条的 id,会话中途打开
        // (hydration 拉走已落库的整条时间线) 之后到达的合并帧会被当成重复**整帧丢弃**,
        // 尾部文本凭空消失。`timestamp` 保持首条的:它只用于时间线边界,偏差上限一个
        // 合帧窗口。
        if self.site == PayloadSite::Nested {
            if let Some(object) = self.merged.as_object_mut() {
                object.insert(
                    "event_id".to_string(),
                    Value::String(Uuid::new_v4().to_string()),
                );
            }
        }
    }
}

fn site_of(event: &Value) -> PayloadSite {
    match event.get("type").and_then(Value::as_str) {
        Some("subagent_timeline") => PayloadSite::Nested,
        _ => PayloadSite::TopLevel,
    }
}

/// delta 的拼接载荷字段。text/reasoning 拼文本,工具入参拼 partial_json。
fn payload_field(event_type: &str) -> Option<&'static str> {
    match event_type {
        "text_delta" | "reasoning_delta" => Some("text"),
        "tool_input_delta" => Some("partial_json"),
        _ => None,
    }
}

fn payload_as_str<'a>(event: &'a Value, site: PayloadSite, field: &str) -> Option<&'a str> {
    let body = match site {
        PayloadSite::TopLevel => event,
        PayloadSite::Nested => event.get("event")?,
    };
    body.get(field)?.as_str()
}

fn payload_str_mut<'a>(
    event: &'a mut Value,
    site: PayloadSite,
    field: &str,
) -> Option<&'a mut String> {
    let body = match site {
        PayloadSite::TopLevel => event,
        PayloadSite::Nested => event.get_mut("event")?,
    };
    match body.get_mut(field)? {
        Value::String(text) => Some(text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_delta(session: &str, index: i64, text: &str) -> Value {
        json!({
            "type": "text_delta",
            "session_id": session,
            "index": index,
            "text": text,
            "event_id": format!("e-{}-{}", index, text),
            "timestamp": "2026-09-22T00:00:00Z",
        })
    }

    fn tool_input_delta(session: &str, index: i64, partial_json: &str) -> Value {
        json!({
            "type": "tool_input_delta",
            "session_id": session,
            "index": index,
            "partial_json": partial_json,
            "event_id": format!("t-{}-{}", index, partial_json),
        })
    }

    #[test]
    fn 同键连续文本增量合并为一条且身份取首条() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        for text in ["He", "llo", " world"] {
            frames.extend(coalescer.push(text_delta("s1", 0, text)));
        }
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["text"], json!("Hello world"));
        assert_eq!(frames[0]["event_id"], json!("e-0-He"));
        assert_eq!(frames[0]["timestamp"], json!("2026-09-22T00:00:00Z"));
        assert_eq!(frames[0]["index"], json!(0));
        assert!(frames[0].get("sequence").is_none());
    }

    #[test]
    fn 语义事件前先冲出挂起增量_不得超车() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(text_delta("s1", 0, "a")));
        frames.extend(coalescer.push(text_delta("s1", 0, "b")));
        frames.extend(coalescer.push(json!({
            "type": "user_message",
            "session_id": "s1",
            "content": "hi",
            "event_id": "u-1",
            "sequence": 7,
        })));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], json!("text_delta"));
        assert_eq!(frames[0]["text"], json!("ab"));
        assert_eq!(frames[1]["type"], json!("user_message"));
        assert_eq!(frames[1]["sequence"], json!(7));
    }

    #[test]
    fn 不同内容块不合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(text_delta("s1", 0, "a")));
        frames.extend(coalescer.push(text_delta("s1", 1, "b")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["text"], json!("a"));
        assert_eq!(frames[1]["text"], json!("b"));
    }

    #[test]
    fn 文本与推理增量同键位也不合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(json!({
            "type": "reasoning_delta",
            "session_id": "s1",
            "index": 0,
            "text": "think",
            "event_id": "r-1",
        })));
        frames.extend(coalescer.push(text_delta("s1", 0, "say")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], json!("reasoning_delta"));
        assert_eq!(frames[1]["type"], json!("text_delta"));
    }

    #[test]
    fn 工具入参增量按partial_json拼接() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(tool_input_delta("s1", 2, "{\"pa")));
        frames.extend(coalescer.push(tool_input_delta("s1", 2, "th\":\"x\"}")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["partial_json"], json!("{\"path\":\"x\"}"));
    }

    #[test]
    fn 不同会话不合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(text_delta("s1", 0, "a")));
        frames.extend(coalescer.push(text_delta("s2", 0, "b")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["session_id"], json!("s1"));
        assert_eq!(frames[1]["session_id"], json!("s2"));
    }

    #[test]
    fn 畸形载荷原样透传不参与合并() {
        let mut coalescer = DeltaCoalescer::new();
        let malformed = json!({
            "type": "text_delta",
            "session_id": "s1",
            "index": 0,
            "text": 123,
            "event_id": "bad-1",
        });
        let frames = coalescer.push(malformed.clone());

        assert_eq!(frames, vec![malformed]);
    }

    #[test]
    fn 空输入不产生帧() {
        let mut coalescer = DeltaCoalescer::new();
        assert!(coalescer.flush().is_empty());
    }

    /// 子智能体时间线帧：delta 包在 `event` 里，身份还要带 `subagent_id`。
    fn subagent_text_delta(session: &str, subagent: &str, index: i64, text: &str) -> Value {
        json!({
            "type": "subagent_timeline",
            "session_id": session,
            "subagent_id": subagent,
            "event": {
                "type": "text_delta",
                "index": index,
                "text": text,
                "event_id": format!("se-{}-{}", index, text),
                "sequence": 3,
            },
            "event_id": format!("w-{}-{}", index, text),
            "timestamp": "2026-09-22T00:00:00Z",
        })
    }

    #[test]
    fn 子智能体连续文本增量合并且换新的外层event_id() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        for text in ["结", "论", "：ok"] {
            frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, text)));
        }
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], json!("subagent_timeline"));
        assert_eq!(frames[0]["subagent_id"], json!("sub-1"));
        assert_eq!(frames[0]["event"]["type"], json!("text_delta"));
        assert_eq!(frames[0]["event"]["text"], json!("结论：ok"));
        // 合并帧必须换一个外层 id：客户端按 event_id 去重，而合帧前每条 delta 都已
        // 各自落库，沿用首条 id 会让「中途打开会话」后的合并帧被整帧判为重复。
        assert_ne!(frames[0]["event_id"], json!("w-0-结"));
        // 外层身份与时间戳保持首条，子智能体帧不参与父时间线的 sequence 空间。
        assert_eq!(frames[0]["timestamp"], json!("2026-09-22T00:00:00Z"));
        assert!(frames[0].get("sequence").is_none());
    }

    #[test]
    fn 只吸收一条的子智能体帧不换event_id() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "a")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 1);
        // 没有发生合并，这一帧就是原帧：换 id 反而会让客户端把它当成新事件重复追加。
        assert_eq!(frames[0]["event_id"], json!("w-0-a"));
        assert_eq!(frames[0]["event"]["event_id"], json!("se-0-a"));
    }

    #[test]
    fn 不同子智能体的同号index不合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "a")));
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-2", 0, "b")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["subagent_id"], json!("sub-1"));
        assert_eq!(frames[1]["subagent_id"], json!("sub-2"));
    }

    #[test]
    fn 子智能体帧与父时间线帧不合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(text_delta("s1", 0, "parent")));
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "child")));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], json!("text_delta"));
        assert_eq!(frames[0]["text"], json!("parent"));
        assert_eq!(frames[1]["type"], json!("subagent_timeline"));
    }

    #[test]
    fn 子智能体的状态帧前先冲出挂起增量() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "a")));
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "b")));
        frames.extend(coalescer.push(json!({
            "type": "subagent_upsert",
            "session_id": "s1",
            "subagent_id": "sub-1",
            "status": "completed",
            "event_id": "up-1",
        })));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        // 顺序不能倒：文本必须排在状态变更之前，否则卡片会先终态再突然冒出正文。
        assert_eq!(frames[0]["type"], json!("subagent_timeline"));
        assert_eq!(frames[0]["event"]["text"], json!("ab"));
        assert_eq!(frames[1]["type"], json!("subagent_upsert"));
        assert_eq!(frames[1]["status"], json!("completed"));
    }

    #[test]
    fn 子智能体工具帧不参与合并() {
        let mut coalescer = DeltaCoalescer::new();
        let mut frames = Vec::new();
        frames.extend(coalescer.push(subagent_text_delta("s1", "sub-1", 0, "a")));
        frames.extend(coalescer.push(json!({
            "type": "subagent_timeline",
            "session_id": "s1",
            "subagent_id": "sub-1",
            "event": { "type": "tool_started", "tool_use_id": "t1", "name": "Grep", "input": {} },
            "event_id": "w-tool",
        })));
        frames.extend(coalescer.flush());

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["event"]["text"], json!("a"));
        assert_eq!(frames[1]["event"]["type"], json!("tool_started"));
        // 语义帧是原帧透传，外层 id 不该被动过。
        assert_eq!(frames[1]["event_id"], json!("w-tool"));
    }
}
