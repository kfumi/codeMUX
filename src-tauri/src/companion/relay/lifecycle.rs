use tauri::{AppHandle, Manager};

use crate::companion::e2ee::load_or_create_e2ee_keypair;
use crate::companion::relay::start_relay_transport;
use crate::companion::state::CompanionState;
use crate::AppState;

pub async fn stop_relay_transport(companion_state: &CompanionState) {
    let controller = companion_state.take_relay_controller().await;
    if let Some(controller) = controller {
        controller.stop().await;
    }
}

pub async fn sync_relay_transport(
    app: &AppHandle,
    companion_state: &CompanionState,
) -> Result<(), String> {
    stop_relay_transport(companion_state).await;

    let app_state = app.state::<AppState>();
    let (relay, port, desktop_id, companion_enabled) = {
        let config = app_state.config.lock().map_err(|error| error.to_string())?;
        (
            config.companion.relay.clone(),
            config.companion.port,
            config.companion.desktop_id.clone().unwrap_or_default(),
            companion_state.inner.is_enabled(),
        )
    };

    if !relay.enabled || desktop_id.trim().is_empty() || !companion_enabled {
        companion_state.clear_e2ee_public_key().await;
        return Ok(());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let bundle = load_or_create_e2ee_keypair(&app_data_dir)?;
    companion_state
        .set_e2ee_public_key_b64(bundle.public_key_b64.clone())
        .await;

    let controller = start_relay_transport(
        relay.endpoint,
        relay.use_tls,
        desktop_id,
        port,
        bundle.key_pair,
        companion_state.relay_state(),
    );
    companion_state.set_relay_controller(controller).await;
    Ok(())
}

pub async fn set_relay_enabled(
    app: &AppHandle,
    companion_state: &CompanionState,
    enabled: bool,
) -> Result<(), String> {
    {
        let app_state = app.state::<AppState>();
        let mut config = app_state.config.lock().map_err(|error| error.to_string())?;
        config.companion.relay.enabled = enabled;
        crate::config::save_config(app, &config)?;
    }
    sync_relay_transport(app, companion_state).await
}
