use futures::StreamExt;
use reqwest::Client;
use tokio::sync::mpsc;

use super::types::{AiProvider, ChatMessage, ChatRequest, ChatResponse, StreamChunk};

pub struct OpenAICompatProvider {
    pub api_key: String,
    pub endpoint_url: String,
    pub default_model: String,
}

impl OpenAICompatProvider {
    pub fn new(api_key: String, endpoint_url: String, default_model: String) -> Self {
        Self {
            api_key,
            endpoint_url,
            default_model,
        }
    }

    fn chat_url(&self) -> String {
        let base = self.endpoint_url.trim_end_matches('/');
        format!("{}/chat/completions", base)
    }
}

impl AiProvider for OpenAICompatProvider {
    fn send_message(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send {
        let url = self.chat_url();
        let api_key = self.api_key.clone();
        let model = if model.is_empty() {
            self.default_model.clone()
        } else {
            model.to_string()
        };

        async move {
            let client = Client::new();
            let body = ChatRequest {
                model,
                messages,
                stream: false,
            };

            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("API error {}: {}", status, text));
            }

            let chat_resp: ChatResponse = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            chat_resp
                .choices
                .into_iter()
                .next()
                .map(|c| c.message.content)
                .ok_or_else(|| "No choices in response".to_string())
        }
    }

    fn send_message_stream(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
    ) -> impl std::future::Future<Output = Result<mpsc::Receiver<String>, String>> + Send {
        let url = self.chat_url();
        let api_key = self.api_key.clone();
        let model = if model.is_empty() {
            self.default_model.clone()
        } else {
            model.to_string()
        };

        async move {
            let client = Client::new();
            let body = ChatRequest {
                model,
                messages,
                stream: true,
            };

            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("API error {}: {}", status, text));
            }

            let (tx, rx) = mpsc::channel::<String>(256);

            tokio::spawn(async move {
                let mut stream = resp.bytes_stream();
                let mut buffer = String::new();

                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(chunk) => {
                            buffer.push_str(&String::from_utf8_lossy(&chunk));

                            while let Some(line_end) = buffer.find('\n') {
                                let line = buffer[..line_end].trim().to_string();
                                buffer = buffer[line_end + 1..].to_string();

                                if line.is_empty() {
                                    continue;
                                }

                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" {
                                        return;
                                    }

                                    if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                                        if let Some(choice) = chunk.choices.into_iter().next() {
                                            if let Some(content) = choice.delta.content {
                                                if tx.send(content).await.is_err() {
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(_e) => {
                            // Stream error - just close
                            return;
                        }
                    }
                }
            });

            Ok(rx)
        }
    }
}
