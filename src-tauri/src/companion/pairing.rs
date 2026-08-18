use chrono::Utc;
use uuid::Uuid;

use crate::db::operations::{hash_pairing_token, insert_paired_device};
use crate::AppState;

pub struct PairingResult {
    pub device_id: String,
    pub token: String,
}

pub fn complete_pairing(
    state: &AppState,
    device_name: Option<&str>,
) -> Result<PairingResult, String> {
    let device_id = Uuid::new_v4().to_string();
    let token = format!("cmx_{}", Uuid::new_v4());
    let token_hash = hash_pairing_token(&token);
    let name = device_name.unwrap_or("Mobile Device").trim();
    let name = if name.is_empty() {
        "Mobile Device"
    } else {
        name
    };
    let paired_at = Utc::now().to_rfc3339();

    let db = state.db.lock().map_err(|error| error.to_string())?;
    insert_paired_device(&db, &device_id, name, &token_hash, &paired_at)
        .map_err(|error| error.to_string())?;

    Ok(PairingResult { device_id, token })
}
