use local_ip_address::local_ip;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::companion::desktop_id::get_or_create_desktop_id;
use crate::companion::offer::build_pairing_offer;
use crate::companion::pairing_code::{
    clear_persisted_pairing_code, ensure_persisted_pairing_code, refresh_persisted_pairing_code,
    resolve_lan_ip,
};
use crate::companion::relay::{set_relay_config, set_relay_enabled, RelayConnectionState};
use crate::companion::{start_daemon_server, stop_daemon_server, CompanionState};
use crate::config;
use crate::db::operations::{self, PairedDevice};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRelayStatus {
    pub enabled: bool,
    pub endpoint: String,
    pub use_tls: bool,
    pub connection_state: String,
    pub desktop_public_key_b64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    /// LAN / relay exposure (user-facing "移动伴侣").
    pub enabled: bool,
    /// Loopback daemon is listening.
    pub daemon_ready: bool,
    pub daemon_error: Option<String>,
    pub port: u16,
    pub desktop_id: Option<String>,
    pub lan_ip: Option<String>,
    pub pairing_code: Option<String>,
    pub pairing_code_expires_at: Option<String>,
    pub paired_devices: Vec<PairedDevice>,
    pub relay: CompanionRelayStatus,
}

fn relay_connection_state_label(state: RelayConnectionState) -> &'static str {
    match state {
        RelayConnectionState::Disabled => "disabled",
        RelayConnectionState::Connecting => "connecting",
        RelayConnectionState::Connected => "connected",
        RelayConnectionState::Error => "error",
    }
}

fn ensure_desktop_id_persisted(app: &AppHandle, state: &AppState) -> Result<String, String> {
    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    let had_desktop_id = config
        .companion
        .desktop_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());
    let desktop_id = get_or_create_desktop_id(&mut config.companion);
    if !had_desktop_id {
        config::save_config(app, &config)?;
    }
    Ok(desktop_id)
}

async fn build_companion_status(
    app: &AppHandle,
    state: &AppState,
    companion_state: &CompanionState,
) -> Result<CompanionStatus, String> {
    let desktop_id = ensure_desktop_id_persisted(app, state)?;
    let daemon_ready = companion_state.inner.is_loopback_running();
    let lan_exposed = companion_state.inner.is_lan_exposed();
    let detected_lan_ip = local_ip().ok().map(|ip| ip.to_string());

    let (
        port,
        relay_config,
        paired_devices,
        lan_ip,
        pairing_code,
        pairing_code_expires_at,
        should_save_config,
    ) = {
        let mut config = state.config.lock().map_err(|error| error.to_string())?;
        let port = config.companion.port;
        let relay_config = config.companion.relay.clone();
        let db = state.db.lock().map_err(|error| error.to_string())?;
        let paired_devices =
            operations::list_paired_devices(&db).map_err(|error| error.to_string())?;
        let previous_lan_ip = config.companion.last_lan_ip.clone();
        let lan_ip = resolve_lan_ip(&mut config.companion, detected_lan_ip);
        let mut should_save_config = previous_lan_ip != config.companion.last_lan_ip;
        let (pairing_code, pairing_code_expires_at) = if lan_exposed {
            let previous_code = config.companion.pairing_code.clone();
            let code = ensure_persisted_pairing_code(companion_state, &mut config.companion);
            if config.companion.pairing_code != previous_code {
                should_save_config = true;
            }
            let expires_at = config.companion.pairing_code_expires_at.clone();
            (Some(code), expires_at)
        } else {
            (None, None)
        };
        (
            port,
            relay_config,
            paired_devices,
            lan_ip,
            pairing_code,
            pairing_code_expires_at,
            should_save_config,
        )
    };

    if should_save_config {
        let config = state.config.lock().map_err(|error| error.to_string())?;
        config::save_config(app, &config)?;
    }

    let relay_state = companion_state.relay_state().get().await;
    let desktop_public_key_b64 = companion_state.e2ee_public_key_b64().await;
    let daemon_error = companion_state.daemon_error().await;

    Ok(CompanionStatus {
        enabled: lan_exposed,
        daemon_ready,
        daemon_error,
        port,
        desktop_id: Some(desktop_id),
        lan_ip,
        pairing_code,
        pairing_code_expires_at,
        paired_devices,
        relay: CompanionRelayStatus {
            enabled: relay_config.enabled,
            endpoint: relay_config.endpoint,
            use_tls: relay_config.use_tls,
            connection_state: relay_connection_state_label(relay_state).to_string(),
            desktop_public_key_b64,
        },
    })
}

#[tauri::command]
pub fn get_local_daemon_token(state: State<'_, AppState>) -> Result<String, String> {
    crate::companion::local_daemon_token::ensure_local_daemon_token(&state.app_data_dir, false)
}

#[tauri::command]
pub async fn get_companion_status(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
) -> Result<CompanionStatus, String> {
    build_companion_status(&app, state.inner(), &companion_state).await
}

#[tauri::command]
pub async fn set_companion_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
    enabled: bool,
) -> Result<CompanionStatus, String> {
    {
        let mut config = state.config.lock().map_err(|error| error.to_string())?;
        config.companion.enabled = enabled;
        let _ = get_or_create_desktop_id(&mut config.companion);
        if !enabled {
            clear_persisted_pairing_code(&mut config.companion);
        }
        config::save_config(&app, &config)?;
    }

    if enabled {
        let (port, listen_address) = {
            let config = state.config.lock().map_err(|error| error.to_string())?;
            (
                config.companion.port,
                config.companion.listen_address.clone(),
            )
        };
        if let Err(error) = start_daemon_server(app.clone(), port, true, listen_address).await {
            let mut config = state.config.lock().map_err(|error| error.to_string())?;
            config.companion.enabled = false;
            config::save_config(&app, &config)?;
            companion_state.inner.set_lan_exposed(false);
            companion_state.clear_pairing_codes();
            return Err(error);
        }
    } else {
        let (port, listen_address) = {
            let config = state.config.lock().map_err(|error| error.to_string())?;
            (
                config.companion.port,
                config.companion.listen_address.clone(),
            )
        };
        crate::companion::relay::stop_relay_transport(&companion_state).await;
        companion_state.clear_pairing_codes();
        if let Err(error) = start_daemon_server(app.clone(), port, false, listen_address).await {
            return Err(error);
        }
    }

    build_companion_status(&app, state.inner(), &companion_state).await
}

#[tauri::command]
pub async fn set_companion_relay_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
    enabled: bool,
) -> Result<CompanionStatus, String> {
    set_relay_enabled(&app, &companion_state, enabled).await?;
    build_companion_status(&app, state.inner(), &companion_state).await
}

#[tauri::command]
pub async fn set_companion_relay_config(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
    endpoint: String,
    use_tls: bool,
) -> Result<CompanionStatus, String> {
    set_relay_config(&app, &companion_state, endpoint, use_tls).await?;
    build_companion_status(&app, state.inner(), &companion_state).await
}

#[tauri::command]
pub async fn refresh_companion_pairing_code(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
) -> Result<CompanionStatus, String> {
    if !companion_state.inner.is_lan_exposed() {
        return Err("Companion server is not enabled".to_string());
    }
    {
        let mut config = state.config.lock().map_err(|error| error.to_string())?;
        refresh_persisted_pairing_code(&companion_state, &mut config.companion);
        config::save_config(&app, &config)?;
    }
    build_companion_status(&app, state.inner(), &companion_state).await
}

#[tauri::command]
pub fn is_session_turn_active(
    companion_state: State<'_, CompanionState>,
    session_id: String,
) -> bool {
    companion_state.is_turn_active(&session_id)
}

#[tauri::command]
pub async fn get_companion_pairing_offer(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
) -> Result<crate::companion::offer::CompanionPairingOffer, String> {
    let _ = ensure_desktop_id_persisted(&app, state.inner())?;
    let detected_lan_ip = local_ip().ok().map(|ip| ip.to_string());
    let (desktop_id, port, relay, lan_ip) = {
        let mut config = state.config.lock().map_err(|error| error.to_string())?;
        let mut should_save = false;
        if companion_state.inner.is_lan_exposed() {
            let previous_code = config.companion.pairing_code.clone();
            ensure_persisted_pairing_code(&companion_state, &mut config.companion);
            if config.companion.pairing_code != previous_code {
                should_save = true;
            }
        }
        let previous_lan_ip = config.companion.last_lan_ip.clone();
        let lan_ip = resolve_lan_ip(&mut config.companion, detected_lan_ip);
        if config.companion.last_lan_ip != previous_lan_ip {
            should_save = true;
        }
        let result = (
            config.companion.desktop_id.clone().unwrap_or_default(),
            config.companion.port,
            config.companion.relay.clone(),
            lan_ip,
        );
        if should_save {
            config::save_config(&app, &config)?;
        }
        result
    };
    let desktop_public_key_b64 = companion_state.e2ee_public_key_b64().await;
    build_pairing_offer(
        &companion_state,
        desktop_id,
        port,
        lan_ip,
        Some(relay),
        desktop_public_key_b64,
    )
}

#[cfg(test)]
mod tests {
    use crate::companion::CompanionState;

    #[test]
    fn mobile_companion_disabled_keeps_loopback_daemon_ready() {
        let companion_state = CompanionState::new();
        companion_state.inner.set_loopback_running(true);
        companion_state.inner.set_lan_exposed(false);

        assert!(companion_state.inner.is_loopback_running());
        assert!(!companion_state.inner.is_lan_exposed());
    }
}
