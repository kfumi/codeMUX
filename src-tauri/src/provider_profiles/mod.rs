#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "原生配置渲染 API 将在后续 2B 写入服务接入前仅由单元测试调用"
    )
)]
pub mod native_config;
pub mod types;

pub use types::{migrate_legacy_providers, AgentProfileRegistry};
