use chrono::{Duration, Utc};
use serde::Serialize;

use crate::companion::state::CompanionState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPairingOffer {
    pub v: u8,
    pub desktop_id: String,
    pub pairing_code: String,
    pub lan: Option<CompanionLanEndpoint>,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct CompanionLanEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn build_pairing_offer(
    companion_state: &CompanionState,
    desktop_id: String,
    port: u16,
    lan_ip: Option<String>,
) -> Result<CompanionPairingOffer, String> {
    if !companion_state.inner.is_enabled() {
        return Err("Companion server is not enabled".to_string());
    }

    let pairing_code = companion_state.ensure_pairing_code();
    let expires_at = (Utc::now() + Duration::minutes(5)).to_rfc3339();
    let lan = lan_ip.map(|host| CompanionLanEndpoint { host, port });

    Ok(CompanionPairingOffer {
        v: 1,
        desktop_id,
        pairing_code,
        lan,
        expires_at,
    })
}
