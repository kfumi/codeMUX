use chrono::{Duration, Utc};
use serde::Serialize;

use crate::companion::state::CompanionState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRelayOffer {
    pub endpoint: String,
    pub use_tls: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPairingOffer {
    pub v: u8,
    pub desktop_id: String,
    pub pairing_code: String,
    pub lan: Option<CompanionLanEndpoint>,
    pub relay: Option<CompanionRelayOffer>,
    pub desktop_public_key_b64: Option<String>,
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
    relay: Option<crate::config::types::CompanionRelayConfig>,
    desktop_public_key_b64: Option<String>,
) -> Result<CompanionPairingOffer, String> {
    if !companion_state.inner.is_enabled() {
        return Err("Companion server is not enabled".to_string());
    }

    let pairing_code = companion_state.ensure_pairing_code();
    let expires_at = (Utc::now() + Duration::minutes(5)).to_rfc3339();
    let lan = lan_ip.map(|host| CompanionLanEndpoint { host, port });
    let relay_offer = relay
        .filter(|value| value.enabled)
        .map(|value| CompanionRelayOffer {
            endpoint: value.endpoint,
            use_tls: value.use_tls,
        });
    let desktop_public_key_b64 = if relay_offer.is_some() {
        desktop_public_key_b64
    } else {
        None
    };

    Ok(CompanionPairingOffer {
        v: 1,
        desktop_id,
        pairing_code,
        lan,
        relay: relay_offer,
        desktop_public_key_b64,
        expires_at,
    })
}
