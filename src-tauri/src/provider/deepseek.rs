use super::openai_compat::OpenAICompatProvider;
use super::types::{AiProvider, ChatMessage};
use tokio::sync::mpsc;

pub struct DeepSeekProvider {
    inner: OpenAICompatProvider,
}

impl DeepSeekProvider {
    pub fn new(api_key: String, endpoint_url: Option<String>) -> Self {
        let endpoint = endpoint_url.unwrap_or_else(|| "https://api.deepseek.com".to_string());
        Self {
            inner: OpenAICompatProvider::new(api_key, endpoint, "deepseek-chat".to_string()),
        }
    }
}

impl AiProvider for DeepSeekProvider {
    fn send_message(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send {
        self.inner.send_message(messages, model)
    }

    fn send_message_stream(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<mpsc::Receiver<String>, String>> + Send {
        self.inner.send_message_stream(messages, model)
    }
}
