pub mod builtins;
pub mod types;

pub use builtins::{builtin_templates, instantiate_template, BuiltinProviderTemplate};
pub use types::{
    effective_api_key, is_provider_usable, normalize_legacy_thinking_levels,
    normalize_thinking_levels, pi_thinking_level, required_protocol, resolve_thinking_levels,
    select_agent_endpoint, select_endpoint, strip_context_1m_suffix, validate_provider,
    validate_provider_for_enable, with_context_1m_suffix, ModelProvider, Protocol,
};

// Only referenced from #[cfg(test)] helpers elsewhere in the crate during non-test builds.
#[cfg_attr(not(test), allow(unused_imports))]
pub use types::{ProtocolEndpoint, ProviderModel};
