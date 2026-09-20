use chrono::{DateTime, Duration, Utc};

use crate::companion::state::CompanionState;
use crate::config::types::CompanionConfig;

pub const PAIRING_CODE_TTL_SECS: i64 = 300;

pub fn ensure_persisted_pairing_code(
    companion_state: &CompanionState,
    companion_config: &mut CompanionConfig,
) -> String {
    if let Some(code) = companion_state.active_pairing_code() {
        return code;
    }

    if let (Some(code), Some(expires_at)) = (
        companion_config.pairing_code.clone(),
        companion_config.pairing_code_expires_at.clone(),
    ) {
        if let Ok(expires_at) = DateTime::parse_from_rfc3339(&expires_at) {
            let expires_at = expires_at.with_timezone(&Utc);
            if expires_at > Utc::now() {
                companion_state.restore_pairing_code(&code, expires_at);
                return code;
            }
        }
    }

    create_and_persist_pairing_code(companion_state, companion_config)
}

pub fn refresh_persisted_pairing_code(
    companion_state: &CompanionState,
    companion_config: &mut CompanionConfig,
) -> String {
    companion_state.clear_pairing_codes();
    clear_persisted_pairing_code(companion_config);
    create_and_persist_pairing_code(companion_state, companion_config)
}

pub fn clear_persisted_pairing_code(companion_config: &mut CompanionConfig) {
    companion_config.pairing_code = None;
    companion_config.pairing_code_expires_at = None;
}

fn create_and_persist_pairing_code(
    companion_state: &CompanionState,
    companion_config: &mut CompanionConfig,
) -> String {
    let code = companion_state.create_pairing_code();
    let expires_at = (Utc::now() + Duration::seconds(PAIRING_CODE_TTL_SECS)).to_rfc3339();
    companion_config.pairing_code = Some(code.clone());
    companion_config.pairing_code_expires_at = Some(expires_at);
    code
}

pub fn resolve_lan_ip(
    companion_config: &mut CompanionConfig,
    detected_ip: Option<String>,
) -> Option<String> {
    if let Some(ip) = detected_ip.filter(|value| !value.trim().is_empty()) {
        companion_config.last_lan_ip = Some(ip.clone());
        return Some(ip);
    }
    companion_config.last_lan_ip.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_valid_persisted_code() {
        let companion_state = CompanionState::new();
        let mut config = CompanionConfig {
            pairing_code: Some("123456".to_string()),
            pairing_code_expires_at: Some((Utc::now() + Duration::minutes(4)).to_rfc3339()),
            ..Default::default()
        };

        let code = ensure_persisted_pairing_code(&companion_state, &mut config);
        assert_eq!(code, "123456");
        assert_eq!(
            companion_state.active_pairing_code().as_deref(),
            Some("123456")
        );
    }
}
