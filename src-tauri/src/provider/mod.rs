pub mod deepseek;
pub mod openai_compat;

use crate::config::types::{ApiType, ProviderConfig};
use deepseek::DeepSeekProvider;
use openai_compat::OpenAICompatProvider;

pub mod types;

use types::AiProvider;

/// Create a boxed provider trait object from a provider config.
///
/// Because `AiProvider` uses RPITIT (impl Future in trait), it is not object-safe,
/// so we cannot return `Box<dyn AiProvider>`. Instead, we return an enum that
/// implements `AiProvider`.
pub fn create_provider(config: &ProviderConfig) -> ProviderImpl {
    match config.api_type {
        ApiType::DeepSeek => ProviderImpl::DeepSeek(DeepSeekProvider::new(
            config.api_key.clone(),
            Some(config.endpoint_url.clone()),
        )),
        ApiType::OpenAICompatible => ProviderImpl::OpenAICompat(OpenAICompatProvider::new(
            config.api_key.clone(),
            config.endpoint_url.clone(),
            config.default_model.clone(),
        )),
        // Claude uses OpenAI-compatible protocol for now
        ApiType::Claude => ProviderImpl::OpenAICompat(OpenAICompatProvider::new(
            config.api_key.clone(),
            config.endpoint_url.clone(),
            config.default_model.clone(),
        )),
    }
}

/// Enum-based provider dispatch since RPITIT traits are not object-safe.
pub enum ProviderImpl {
    DeepSeek(DeepSeekProvider),
    OpenAICompat(OpenAICompatProvider),
}

impl AiProvider for ProviderImpl {
    fn send_message(
        &self,
        messages: Vec<types::ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send {
        // Each variant returns a different opaque future type, so we must
        // .await inside an async block to unify into a single future.
        let model = model.to_string();
        async move {
            match self {
                ProviderImpl::DeepSeek(p) => p.send_message(messages, &model).await,
                ProviderImpl::OpenAICompat(p) => p.send_message(messages, &model).await,
            }
        }
    }

    fn send_message_stream(
        &self,
        messages: Vec<types::ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<tokio::sync::mpsc::Receiver<String>, String>> + Send
    {
        let model = model.to_string();
        async move {
            match self {
                ProviderImpl::DeepSeek(p) => p.send_message_stream(messages, &model).await,
                ProviderImpl::OpenAICompat(p) => p.send_message_stream(messages, &model).await,
            }
        }
    }
}
