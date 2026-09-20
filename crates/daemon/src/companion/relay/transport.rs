use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::companion::e2ee::channel::DaemonChannel;
use crate::companion::e2ee::KeyPair;
use crate::companion::relay::tunnel::handle_tunnel_payload;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayConnectionState {
    Disabled,
    Connecting,
    Connected,
    Error,
}

#[derive(Clone)]
pub struct RelayTransportState {
    inner: Arc<RwLock<RelayConnectionState>>,
}

impl RelayTransportState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(RelayConnectionState::Disabled)),
        }
    }

    pub async fn get(&self) -> RelayConnectionState {
        *self.inner.read().await
    }

    async fn set(&self, state: RelayConnectionState) {
        *self.inner.write().await = state;
    }
}

impl Default for RelayTransportState {
    fn default() -> Self {
        Self::new()
    }
}

pub struct RelayTransportController {
    stop_tx: mpsc::Sender<()>,
    state: RelayTransportState,
    data_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

async fn abort_data_tasks(data_tasks: &Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>) {
    let handles = {
        let mut tasks = data_tasks.lock().await;
        tasks.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
    };
    for handle in handles {
        handle.abort();
        let _ = handle.await;
    }
}

impl RelayTransportController {
    pub async fn stop(self) {
        let _ = self.stop_tx.send(()).await;
        abort_data_tasks(&self.data_tasks).await;
        self.state.set(RelayConnectionState::Disabled).await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlMessage {
    Sync {
        #[serde(rename = "connectionIds")]
        connection_ids: Vec<String>,
    },
    Connected {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    Disconnected {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    Ping,
    Pong,
}

fn build_relay_url(
    endpoint: &str,
    use_tls: bool,
    server_id: &str,
    role: &str,
    connection_id: Option<&str>,
) -> Result<String, String> {
    let trimmed = endpoint.trim();
    let (host, port) = if let Some((host, port)) = trimmed.rsplit_once(':') {
        (host, port.parse::<u16>().map_err(|_| "Invalid relay port")?)
    } else {
        (trimmed, if use_tls { 443 } else { 80 })
    };
    let protocol = if use_tls { "wss" } else { "ws" };
    let mut url = format!("{protocol}://{host}:{port}/ws?serverId={server_id}&role={role}&v=2");
    if let Some(connection_id) = connection_id {
        url.push_str(&format!("&connectionId={connection_id}"));
    }
    Ok(url)
}

pub fn start_relay_transport(
    endpoint: String,
    use_tls: bool,
    server_id: String,
    companion_port: u16,
    daemon_key_pair: KeyPair,
    state: RelayTransportState,
) -> RelayTransportController {
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let data_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let state_for_task = state.clone();
    let data_tasks_for_task = data_tasks.clone();
    tokio::spawn(async move {
        let mut attempt = 0u32;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            state_for_task.set(RelayConnectionState::Connecting).await;
            let control_url = match build_relay_url(&endpoint, use_tls, &server_id, "server", None)
            {
                Ok(url) => url,
                Err(error) => {
                    warn!(target: "companion", "Invalid relay URL: {}", error);
                    state_for_task.set(RelayConnectionState::Error).await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };

            match connect_async(&control_url).await {
                Ok((ws, _)) => {
                    attempt = 0;
                    state_for_task.set(RelayConnectionState::Connected).await;
                    info!(target: "companion", "Relay control connected: {}", control_url);
                    let (mut write, mut read) = ws.split();
                    let data_tasks_for_read = data_tasks_for_task.clone();
                    let endpoint_for_data = endpoint.clone();
                    let server_id_for_data = server_id.clone();
                    let companion_port_for_data = companion_port;
                    let daemon_key_pair_for_data = daemon_key_pair.clone();

                    loop {
                        tokio::select! {
                            _ = stop_rx.recv() => {
                                let _ = write.close().await;
                                return;
                            }
                            incoming = read.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Ok(message) = serde_json::from_str::<ControlMessage>(&text) {
                                            match message {
                                                ControlMessage::Sync { connection_ids } => {
                                                    for connection_id in connection_ids {
                                                        spawn_data_socket(
                                                            endpoint_for_data.clone(),
                                                            use_tls,
                                                            server_id_for_data.clone(),
                                                            connection_id,
                                                            companion_port_for_data,
                                                            daemon_key_pair_for_data.clone(),
                                                            data_tasks_for_read.clone(),
                                                        ).await;
                                                    }
                                                }
                                                ControlMessage::Ping => {
                                                    let _ = write.send(Message::Text(json!({"type":"pong"}).to_string().into())).await;
                                                }
                                                ControlMessage::Connected { connection_id } => {
                                                    spawn_data_socket(
                                                        endpoint_for_data.clone(),
                                                        use_tls,
                                                        server_id_for_data.clone(),
                                                        connection_id.clone(),
                                                        companion_port_for_data,
                                                        daemon_key_pair_for_data.clone(),
                                                        data_tasks_for_read.clone(),
                                                    ).await;
                                                }
                                                ControlMessage::Disconnected { connection_id } => {
                                                    let mut tasks = data_tasks_for_read.lock().await;
                                                    if let Some(handle) = tasks.remove(&connection_id) {
                                                        handle.abort();
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                    Some(Ok(Message::Ping(payload))) => {
                                        let _ = write.send(Message::Pong(payload)).await;
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Err(error)) => {
                                        warn!(target: "companion", "Relay control error: {}", error);
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    warn!(target: "companion", "Relay control connect failed: {}", error);
                    state_for_task.set(RelayConnectionState::Error).await;
                }
            }

            attempt = attempt.saturating_add(1);
            let delay = Duration::from_secs(std::cmp::min(30, 2u64.pow(attempt.min(4))));
            tokio::time::sleep(delay).await;
        }
        state_for_task.set(RelayConnectionState::Disabled).await;
    });

    RelayTransportController {
        stop_tx,
        state,
        data_tasks,
    }
}

async fn spawn_data_socket(
    endpoint: String,
    use_tls: bool,
    server_id: String,
    connection_id: String,
    companion_port: u16,
    daemon_key_pair: KeyPair,
    data_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
) {
    let connection_id_for_task = connection_id.clone();
    let handle = tokio::spawn(async move {
        let url = match build_relay_url(
            &endpoint,
            use_tls,
            &server_id,
            "server",
            Some(&connection_id_for_task),
        ) {
            Ok(url) => url,
            Err(_) => return,
        };
        let Ok((ws, _)) = connect_async(&url).await else {
            return;
        };
        let (mut write, mut read) = ws.split();
        let mut channel = DaemonChannel::new(daemon_key_pair);
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{companion_port}");

        while let Some(message) = read.next().await {
            match message {
                Ok(Message::Text(text)) if !channel.is_open() => {
                    if let Ok(Some(ready)) = channel.handle_hello(&text) {
                        let _ = write.send(Message::Text(ready.into())).await;
                    }
                    continue;
                }
                Ok(Message::Binary(payload)) => {
                    if !channel.is_open() {
                        continue;
                    }
                    match channel.decrypt_inbound(&payload) {
                        Ok(plaintext) => {
                            if let Ok(response) =
                                handle_tunnel_payload(&client, &base, &plaintext).await
                            {
                                if let Ok(encrypted) = channel.encrypt_outbound(&response) {
                                    let _ = write.send(Message::Binary(encrypted.into())).await;
                                }
                            }
                        }
                        Err(error) => {
                            warn!(target: "companion", "Relay tunnel decrypt failed: {}", error);
                            break;
                        }
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });

    let mut tasks = data_tasks.lock().await;
    if let Some(previous) = tasks.insert(connection_id, handle) {
        previous.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_camel_case_relay_control_fields() {
        let connected = serde_json::from_str::<ControlMessage>(
            r#"{"type":"connected","connectionId":"connection-1"}"#,
        )
        .expect("connected control message should parse");
        assert!(matches!(
            connected,
            ControlMessage::Connected { connection_id } if connection_id == "connection-1"
        ));

        let sync = serde_json::from_str::<ControlMessage>(
            r#"{"type":"sync","connectionIds":["connection-1"]}"#,
        )
        .expect("sync control message should parse");
        assert!(matches!(
            sync,
            ControlMessage::Sync { connection_ids } if connection_ids == vec!["connection-1"]
        ));
    }

    #[tokio::test]
    async fn aborts_all_data_tasks() {
        let data_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        data_tasks.lock().await.insert(
            "connection-1".to_string(),
            tokio::spawn(async {
                std::future::pending::<()>().await;
            }),
        );

        abort_data_tasks(&data_tasks).await;

        assert!(data_tasks.lock().await.is_empty());
    }
}
