use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::crypto::{export_public_key_b64, generate_keypair, import_public_key_b64, KeyPair};
use base64::Engine;
use sodiumoxide::crypto::box_::curve25519xsalsa20poly1305::SecretKey;

const KEYPAIR_FILENAME: &str = "companion-e2ee-keypair.json";

#[derive(Debug, Serialize, Deserialize)]
struct StoredKeyPair {
    v: u8,
    public_key_b64: String,
    secret_key_b64: String,
}

pub struct E2eeKeyPairBundle {
    pub key_pair: KeyPair,
    pub public_key_b64: String,
}

fn keypair_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join(KEYPAIR_FILENAME)
}

fn encode_secret_key_b64(secret_key: &SecretKey) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret_key.as_ref())
}

fn decode_secret_key_b64(value: &str) -> Result<SecretKey, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|error| error.to_string())?;
    SecretKey::from_slice(&bytes).ok_or_else(|| "Invalid secret key length".to_string())
}

pub fn load_or_create_e2ee_keypair(app_data_dir: &PathBuf) -> Result<E2eeKeyPairBundle, String> {
    let path = keypair_path(app_data_dir);
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<StoredKeyPair>(&raw) {
                if parsed.v == 1 {
                    let public_key = import_public_key_b64(&parsed.public_key_b64)?;
                    let secret_key = decode_secret_key_b64(&parsed.secret_key_b64)?;
                    let public_key_b64 = export_public_key_b64(&public_key);
                    return Ok(E2eeKeyPairBundle {
                        key_pair: KeyPair { public_key, secret_key },
                        public_key_b64,
                    });
                }
            }
        }
    }

    let key_pair = generate_keypair();
    let public_key_b64 = export_public_key_b64(&key_pair.public_key);
    let secret_key_b64 = encode_secret_key_b64(&key_pair.secret_key);
    let payload = StoredKeyPair {
        v: 1,
        public_key_b64: public_key_b64.clone(),
        secret_key_b64,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;

    Ok(E2eeKeyPairBundle { key_pair, public_key_b64 })
}
