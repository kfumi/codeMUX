//! Agent Kind 的 daemon 侧映射与命令信封。
//!
//! daemon **不驾驶**运行时：真正的运行时在 sidecar 内（`apps/sidecar/src`），
//! 这里只有两件事 —— kind 字符串到规范名的映射，以及发给 sidecar 的命令信封。
//!
//! 曾经这里有 `AgentRuntime` trait 与四个空实现（六个方法只打日志再返回
//! `Ok(())`），`session_runtime()` 零调用点。那个 trait 是浅模块的典型：接口
//! 几乎与实现一样宽，而实现什么都不做，还让读者误以为 daemon 在驾驶运行时。

pub mod factory;
pub mod opencode;
pub mod types;
