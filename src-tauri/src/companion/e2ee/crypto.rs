use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sodiumoxide::crypto::box_;
use sodiumoxide::crypto::box_::curve25519xsalsa20poly1305::{PublicKey, SecretKey};

pub struct KeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
}

impl Clone for KeyPair {
    fn clone(&self) -> Self {
        Self {
            public_key: self.public_key,
            secret_key: self.secret_key.clone(),
        }
    }
}

pub fn init() {
    let _ = sodiumoxide::init();
}

pub fn generate_keypair() -> KeyPair {
    init();
    let (public_key, secret_key) = box_::gen_keypair();
    KeyPair {
        public_key,
        secret_key,
    }
}

pub fn export_public_key_b64(public_key: &PublicKey) -> String {
    URL_SAFE_NO_PAD.encode(public_key.as_ref())
}

pub fn import_public_key_b64(value: &str) -> Result<PublicKey, String> {
    init();
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|error| error.to_string())?;
    PublicKey::from_slice(&bytes).ok_or_else(|| "Invalid public key length".to_string())
}

pub fn derive_shared_key(our_secret: &SecretKey, their_public: &PublicKey) -> box_::PrecomputedKey {
    init();
    box_::precompute(their_public, our_secret)
}

pub fn encrypt(precomputed: &box_::PrecomputedKey, plaintext: &[u8]) -> Vec<u8> {
    init();
    let nonce = box_::gen_nonce();
    let ciphertext = box_::seal_precomputed(plaintext, &nonce, precomputed);
    let mut out = Vec::with_capacity(box_::NONCEBYTES + ciphertext.len());
    out.extend_from_slice(nonce.as_ref());
    out.extend_from_slice(&ciphertext);
    out
}

pub fn decrypt(precomputed: &box_::PrecomputedKey, payload: &[u8]) -> Result<Vec<u8>, String> {
    init();
    if payload.len() < box_::NONCEBYTES {
        return Err("Ciphertext bundle too short".to_string());
    }
    let (nonce_bytes, ciphertext) = payload.split_at(box_::NONCEBYTES);
    let nonce = box_::Nonce::from_slice(nonce_bytes).ok_or_else(|| "Invalid nonce".to_string())?;
    box_::open_precomputed(ciphertext, &nonce, precomputed)
        .map_err(|_| "Decryption failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let alice = generate_keypair();
        let bob = generate_keypair();
        let alice_shared = derive_shared_key(&alice.secret_key, &bob.public_key);
        let bob_shared = derive_shared_key(&bob.secret_key, &alice.public_key);
        let plaintext = b"hello companion e2ee";
        let ciphertext = encrypt(&alice_shared, plaintext);
        let opened = decrypt(&bob_shared, &ciphertext).expect("decrypt");
        assert_eq!(opened, plaintext);
    }

    #[test]
    fn public_key_roundtrip_b64() {
        let keypair = generate_keypair();
        let encoded = export_public_key_b64(&keypair.public_key);
        let imported = import_public_key_b64(&encoded).expect("import");
        assert_eq!(imported.as_ref(), keypair.public_key.as_ref());
    }
}
