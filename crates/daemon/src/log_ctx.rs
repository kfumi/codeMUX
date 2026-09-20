use std::future::Future;

#[derive(Default, Clone)]
pub struct LogCtx {
    pub session_id: Option<String>,
    pub message_id: Option<String>,
}

impl LogCtx {
    pub fn with_session(session_id: &str) -> Self {
        Self {
            session_id: Some(session_id.to_string()),
            message_id: None,
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
    LOG_CTX.scope(ctx, f()).await
}

pub fn prefix() -> String {
    LOG_CTX
        .try_with(|ctx| {
            let mut parts = Vec::new();
            if let Some(session_id) = &ctx.session_id {
                parts.push(format!("[session={session_id}]"));
            }
            if let Some(message_id) = &ctx.message_id {
                parts.push(format!("[msg={message_id}]"));
            }
            if parts.is_empty() {
                return String::new();
            }
            parts.join("")
        })
        .unwrap_or_default()
}

#[macro_export]
macro_rules! log_ctx {
    ($level:ident, target: $target:expr, $($arg:tt)+) => {
        let __prefix = $crate::log_ctx::prefix();
        if __prefix.is_empty() {
            log::$level!(target: $target, $($arg)+);
        } else {
            log::$level!(target: $target, "{} {}", __prefix, format_args!($($arg)+));
        }
    };
    ($level:ident, $($arg:tt)+) => {
        let __prefix = $crate::log_ctx::prefix();
        if __prefix.is_empty() {
            log::$level!($($arg)+);
        } else {
            log::$level!("{} {}", __prefix, format_args!($($arg)+));
        }
    };
}
