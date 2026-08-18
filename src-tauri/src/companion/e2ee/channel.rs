use serde::{Deserialize, Serialize};

use super::crypto::{decrypt, derive_shared_key, encrypt, import_public_key_b64, KeyPair};
use sodiumoxide::crypto::box_;

#[derive(Debug)]
pub enum E2eeHandshakeError {
    InvalidHello(String),
    KeyMismatch,
}

impl std::fmt::Display for E2eeHandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHello(message) => write!(f, "{message}"),
            Self::KeyMismatch => write!(f, "E2EE re-handshake key mismatch"),
        }
    }
}

impl std::error::Error for E2eeHandshakeError {}

#[derive(Debug, Deserialize)]
struct HelloMessage {
    #[serde(rename = "type")]
    message_type: String,
    key: String,
}

#[derive(Debug, Serialize)]
struct ReadyMessage {
    #[serde(rename = "type")]
    message_type: &'static str,
}

pub struct DaemonChannel {
    daemon_key_pair: KeyPair,
    precomputed: Option<box_::PrecomputedKey>,
    client_public_key: Option<Vec<u8>>,
}

impl DaemonChannel {
    pub fn new(daemon_key_pair: KeyPair) -> Self {
        Self {
            daemon_key_pair,
            precomputed: None,
            client_public_key: None,
        }
    }

    pub fn handle_hello(&mut self, text: &str) -> Result<Option<String>, E2eeHandshakeError> {
        let parsed: HelloMessage = serde_json::from_str(text)
            .map_err(|error| E2eeHandshakeError::InvalidHello(error.to_string()))?;
        if parsed.message_type != "e2ee_hello" {
            return Err(E2eeHandshakeError::InvalidHello(
                "Expected e2ee_hello".to_string(),
            ));
        }
        let client_public = import_public_key_b64(&parsed.key)
            .map_err(|error| E2eeHandshakeError::InvalidHello(error))?;
        let client_public_bytes = client_public.as_ref().to_vec();

        if let Some(existing) = &self.client_public_key {
            if existing == &client_public_bytes {
                return Ok(Some(
                    serde_json::to_string(&ReadyMessage {
                        message_type: "e2ee_ready",
                    })
                    .unwrap(),
                ));
            }
            return Err(E2eeHandshakeError::KeyMismatch);
        }

        self.client_public_key = Some(client_public_bytes);
        self.precomputed = Some(derive_shared_key(
            &self.daemon_key_pair.secret_key,
            &client_public,
        ));
        Ok(Some(
            serde_json::to_string(&ReadyMessage {
                message_type: "e2ee_ready",
            })
            .unwrap(),
        ))
    }

    pub fn is_open(&self) -> bool {
        self.precomputed.is_some()
    }

    pub fn decrypt_inbound(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let precomputed = self
            .precomputed
            .as_ref()
            .ok_or_else(|| "E2EE channel not open".to_string())?;
        decrypt(precomputed, payload)
    }

    pub fn encrypt_outbound(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let precomputed = self
            .precomputed
            .as_ref()
            .ok_or_else(|| "E2EE channel not open".to_string())?;
        Ok(encrypt(precomputed, plaintext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::e2ee::crypto::generate_keypair;

    #[test]
    fn handshake_and_rehello() {
        let daemon = generate_keypair();
        let client = generate_keypair();
        let client_public_b64 =
            crate::companion::e2ee::crypto::export_public_key_b64(&client.public_key);
        let hello = serde_json::json!({
            "type": "e2ee_hello",
            "key": client_public_b64,
        })
        .to_string();

        let mut channel = DaemonChannel::new(daemon);
        let ready = channel.handle_hello(&hello).expect("hello");
        assert!(ready.is_some());
        assert!(channel.is_open());

        let ready_again = channel.handle_hello(&hello).expect("rehello");
        assert!(ready_again.is_some());
    }
}
