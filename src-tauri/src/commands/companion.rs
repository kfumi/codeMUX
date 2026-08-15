use local_ip_address::local_ip;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::companion::{start_companion_server, stop_companion_server, CompanionState};
use crate::config;
use crate::db::operations::{self, PairedDevice};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub enabled: bool,
    pub port: u16,
    pub lan_ip: Option<String>,
    pub pairing_code: Option<String>,
    pub paired_devices: Vec<PairedDevice>,
}

#[tauri::command]
pub async fn get_companion_status(
    _app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
) -> Result<CompanionStatus, String> {
    let config = state.config.lock().map_err(|error| error.to_string())?;
    let port = config.companion.port;
    let enabled = companion_state.inner.is_enabled();
    let pairing_code = if enabled {
        Some(companion_state.create_pairing_code())
    } else {
        None
    };
    let db = state.db.lock().map_err(|error| error.to_string())?;
    let paired_devices = operations::list_paired_devices(&db).map_err(|error| error.to_string())?;
    let lan_ip = local_ip().ok().map(|ip| ip.to_string());

    Ok(CompanionStatus {
        enabled,
        port,
        lan_ip,
        pairing_code,
        paired_devices,
    })
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
        config::save_config(&app, &config)?;
    }

    if enabled {
        let port = state
            .config
            .lock()
            .map_err(|error| error.to_string())?
            .companion
            .port;
        start_companion_server(app.clone(), port).await?;
    } else {
        stop_companion_server(app.clone()).await?;
        let db = state.db.lock().map_err(|error| error.to_string())?;
        operations::delete_all_paired_devices(&db).map_err(|error| error.to_string())?;
        companion_state.clear_pairing_codes();
    }

    get_companion_status(app, state, companion_state).await
}

#[tauri::command]
pub async fn revoke_companion_device(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
    device_id: String,
) -> Result<CompanionStatus, String> {
    let device_id = device_id.clone();
    {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        operations::delete_paired_device(&db, &device_id).map_err(|error| error.to_string())?;
    }
    get_companion_status(app, state, companion_state).await
}

#[tauri::command]
pub async fn refresh_companion_pairing_code(
    app: AppHandle,
    state: State<'_, AppState>,
    companion_state: State<'_, CompanionState>,
) -> Result<CompanionStatus, String> {
    if !companion_state.inner.is_enabled() {
        return Err("Companion server is not enabled".to_string());
    }
    get_companion_status(app, state, companion_state).await
}
