pub mod builtins;
pub mod types;

pub use builtins::{builtin_templates, instantiate_template, BuiltinProviderTemplate};
pub use types::{
    effective_api_key, is_provider_usable, required_protocol, select_endpoint, validate_provider,
    ModelProvider, Protocol, ProtocolEndpoint, ProviderModel,
};
