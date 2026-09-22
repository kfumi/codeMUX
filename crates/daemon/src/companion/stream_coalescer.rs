use serde_json::Value;

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

/// 一条挂起的合并流:同一 `(type, session_id, index)` 的连续 delta。
/// 身份字段( event_id/timestamp 等)取首条,载荷字符串做拼接。
struct PendingDelta {
    session_id: String,
    event_type: String,
    index: Value,
    merged: Value,
}

impl PendingDelta {
    fn new(event: &Value) -> Option<Self> {
        let event_type = event.get("type")?.as_str()?;
        let field = payload_field(event_type)?;
        let session_id = event.get("session_id")?.as_str()?.to_string();
        let index = event.get("index")?.clone();
        // 首条载荷必须是字符串;畸形事件原样透传,不参与合并。
        payload_as_str(event, field)?;
        Some(Self {
            session_id,
            event_type: event_type.to_string(),
            index,
            merged: event.clone(),
        })
    }

    fn matches(&self, event: &Value) -> bool {
        let Some(field) = payload_field(&self.event_type) else {
            return false;
        };
        event.get("type").and_then(Value::as_str) == Some(self.event_type.as_str())
            && event.get("session_id").and_then(Value::as_str) == Some(self.session_id.as_str())
            && event.get("index") == Some(&self.index)
            && payload_as_str(event, field).is_some()
    }

    fn absorb(&mut self, event: &Value) {
        let field = payload_field(&self.event_type).unwrap_or("text");
        if let (Some(Value::String(dst)), Some(src)) = (
            self.merged.get_mut(field),
            event.get(field).and_then(Value::as_str),
        ) {
            dst.push_str(src);
        }
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

fn payload_as_str<'a>(event: &'a Value, field: &str) -> Option<&'a str> {
    event.get(field).and_then(Value::as_str)
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
}
