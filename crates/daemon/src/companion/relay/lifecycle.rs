use crate::companion::e2ee::load_or_create_e2ee_keypair;
use crate::companion::relay::start_relay_transport;
use crate::companion::state::CompanionState;
use crate::daemon::DaemonState;

pub async fn stop_relay_transport(companion_state: &CompanionState) {
    let controller = companion_state.take_relay_controller().await;
    if let Some(controller) = controller {
        controller.stop().await;
    }
}

pub async fn sync_relay_transport(
    daemon: &DaemonState,
    companion_state: &CompanionState,
) -> Result<(), String> {
    stop_relay_transport(companion_state).await;

    let app_state = &daemon.app;
    let (relay, port, desktop_id, companion_enabled) = {
        let config = app_state.config.lock().map_err(|error| error.to_string())?;
        (
            config.companion.relay.clone(),
            config.companion.port,
            config.companion.desktop_id.clone().unwrap_or_default(),
            // 中继属于「对外暴露」的一部分:关闭移动伴侣时不停回环,但中继必须停
            // (工单 10 / ADR 0008 amendment)。is_enabled() 只是回环运行别名,
            // 不能用来判定是否该连中继。
            companion_state.inner.is_lan_exposed(),
        )
    };

    if !relay.enabled || desktop_id.trim().is_empty() || !companion_enabled {
        companion_state.clear_e2ee_public_key().await;
        return Ok(());
    }

    let bundle = load_or_create_e2ee_keypair(&daemon.roots.app_data_dir)?;
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

pub fn validate_relay_endpoint(endpoint: &str) -> Result<(), String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("请先填写中继端点".to_string());
    }
    let (host, port_str) = trimmed
        .rsplit_once(':')
        .ok_or_else(|| "中继端点格式应为 host:port".to_string())?;
    if host.trim().is_empty() {
        return Err("中继主机不能为空".to_string());
    }
    let port: u16 = port_str.parse().map_err(|_| "中继端口无效".to_string())?;
    if port == 0 {
        return Err("中继端口无效".to_string());
    }
    Ok(())
}

pub async fn set_relay_config(
    daemon: &DaemonState,
    companion_state: &CompanionState,
    endpoint: String,
    use_tls: bool,
) -> Result<(), String> {
    validate_relay_endpoint(&endpoint)?;
    {
        let app_state = &daemon.app;
        let mut config = app_state.config.lock().map_err(|error| error.to_string())?;
        config.companion.relay.endpoint = endpoint.trim().to_string();
        config.companion.relay.use_tls = use_tls;
        crate::config::save_config(&daemon.roots, &config)?;
    }
    sync_relay_transport(daemon, companion_state).await
}

pub async fn set_relay_enabled(
    daemon: &DaemonState,
    companion_state: &CompanionState,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        let endpoint = {
            let app_state = &daemon.app;
            let config = app_state.config.lock().map_err(|error| error.to_string())?;
            config.companion.relay.endpoint.clone()
        };
        validate_relay_endpoint(&endpoint)?;
    }
    {
        let app_state = &daemon.app;
        let mut config = app_state.config.lock().map_err(|error| error.to_string())?;
        config.companion.relay.enabled = enabled;
        crate::config::save_config(&daemon.roots, &config)?;
    }
    sync_relay_transport(daemon, companion_state).await
}
