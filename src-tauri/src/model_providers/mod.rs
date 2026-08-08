pub mod builtins;
pub mod types;

pub use builtins::{builtin_templates, instantiate_template, BuiltinProviderTemplate};
pub use types::{
    effective_api_key, is_provider_usable, required_protocol, select_endpoint, validate_provider,
    validate_provider_for_enable,
    ModelProvider, Protocol,
};

// Only referenced from #[cfg(test)] helpers elsewhere in the crate during non-test builds.
#[cfg_attr(not(test), allow(unused_imports))]
pub use types::{ProtocolEndpoint, ProviderModel};
