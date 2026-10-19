use std::future::Future;

/// 跨进程日志关联头:客户端可携带,daemon 缺省时生成并回写到响应头。
pub const TRACE_HEADER: &str = "x-codemux-trace-id";

#[derive(Default, Clone)]
pub struct LogCtx {
    pub trace_id: Option<String>,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
}

impl LogCtx {
    pub fn with_session(session_id: &str) -> Self {
        Self {
            trace_id: None,
            session_id: Some(session_id.to_string()),
            message_id: None,
        }
    }

    pub fn with_trace(trace_id: &str) -> Self {
        Self {
            trace_id: Some(trace_id.to_string()),
            session_id: None,
            message_id: None,
        }
    }

    /// 未显式提供的字段从外层继承:内层只补 session 时不会丢掉请求级 trace。
    fn merged_with(self, outer: &Self) -> Self {
        Self {
            trace_id: self.trace_id.or_else(|| outer.trace_id.clone()),
            session_id: self.session_id.or_else(|| outer.session_id.clone()),
            message_id: self.message_id.or_else(|| outer.message_id.clone()),
        }
    }
}

tokio::task_local! {
    static LOG_CTX: LogCtx;
}

pub async fn with_ctx<F, Fut, T>(ctx: LogCtx, f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let merged = LOG_CTX
        .try_with(|outer| ctx.clone().merged_with(outer))
        .unwrap_or(ctx);
    LOG_CTX.scope(merged, f()).await
}

/// 当前任务的上下文前缀,如 `[trace=...][session=...][msg=...]`;无上下文时为空串。
pub fn prefix() -> String {
    LOG_CTX
        .try_with(|ctx| {
            let mut out = String::new();
            if let Some(trace_id) = &ctx.trace_id {
                out.push_str(&format!("[trace={trace_id}]"));
            }
            if let Some(session_id) = &ctx.session_id {
                out.push_str(&format!("[session={session_id}]"));
            }
            if let Some(message_id) = &ctx.message_id {
                out.push_str(&format!("[msg={message_id}]"));
            }
            out
        })
        .unwrap_or_default()
}

/// 保留宏形态给既有调用点;前缀统一由 logger 写入,避免重复。
#[macro_export]
macro_rules! log_ctx {
    ($level:ident, target: $target:expr, $($arg:tt)+) => {
        log::$level!(target: $target, $($arg)+)
    };
    ($level:ident, $($arg:tt)+) => {
        log::$level!($($arg)+)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_is_empty_outside_scope() {
        assert_eq!(prefix(), "");
    }

    #[tokio::test]
    async fn prefix_contains_trace_and_session() {
        let ctx = LogCtx {
            trace_id: Some("trace-1".to_string()),
            session_id: Some("session-1".to_string()),
            message_id: Some("msg-1".to_string()),
        };
        let text = with_ctx(ctx, || async { prefix() }).await;
        assert_eq!(text, "[trace=trace-1][session=session-1][msg=msg-1]");
    }

    #[tokio::test]
    async fn inner_scope_inherits_outer_trace() {
        let text = with_ctx(LogCtx::with_trace("trace-1"), || async {
            with_ctx(LogCtx::with_session("session-1"), || async { prefix() }).await
        })
        .await;
        assert_eq!(text, "[trace=trace-1][session=session-1]");
    }
}
