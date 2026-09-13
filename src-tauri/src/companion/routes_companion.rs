//! 移动伴侣(Companion)管理面:状态查询、开关、配对码刷新、中继配置。
//!
//! 这组路由是 Tauri 壳 `commands/companion.rs` 的 daemon 侧对应物。壳退役时
// 命令面被删除,但渲染层的 `useCompanionStatus` 仍在调 `/api/companion/*`,
// 于是 daemon 静态服务兜底把 POST 变成 405 —— 点开「移动伴侣」直接报
// `Daemon request failed: 405`。
//!
//! 语义遵循 ADR 0008 amendment / ADR 0011:`companion.enabled` 只控制局域网与
// 中继暴露以及配对 UI,回环 daemon 始终在跑,关闭移动伴侣不停 Session、不停
// Sidecar。开关动作限回环来源且需鉴权 —— 配对手机不能远程驱动桌面暴露策略。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};

use crate::companion::desktop_id::get_or_create_desktop_id;
use crate::companion::pairing_code::{
    clear_persisted_pairing_code, ensure_persisted_pairing_code, refresh_persisted_pairing_code,
    resolve_lan_ip,
};
use crate::companion::relay::{set_relay_config, set_relay_enabled, RelayConnectionState};
use crate::companion::server::{authorize, is_loopback_peer, ApiError, ServerContext};
use crate::companion::start_daemon_server;
use crate::daemon::DaemonState;
use crate::db::operations::{self, PairedDevice};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanionRelayStatus {
    pub enabled: bool,
    pub endpoint: String,
    pub use_tls: bool,
    pub connection_state: String,
    pub desktop_public_key_b64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanionStatus {
    /// 局域网 / 中继暴露(用户可见的「移动伴侣」开关)。
    pub enabled: bool,
    /// 回环 daemon 是否在监听(与开关无关,始终为真)。
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetRelayEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetRelayConfigRequest {
    endpoint: String,
    use_tls: bool,
}

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/companion/status", get(companion_status))
        .route("/companion/enabled", post(set_companion_enabled))
        .route(
            "/companion/pairing-code/refresh",
            post(refresh_companion_pairing_code),
        )
        .route(
            "/companion/relay/enabled",
            post(set_companion_relay_enabled),
        )
        .route("/companion/relay/config", post(set_companion_relay_config))
}

/// 管理面鉴权:必须来自回环来源(桌面壳 / 同机浏览器)且持有有效令牌。
fn authorize_companion_admin(
    ctx: &ServerContext,
    headers: &HeaderMap,
    peer: SocketAddr,
) -> Result<(), ApiError> {
    if !is_loopback_peer(Some(peer)) {
        return Err(ApiError::forbidden(
            "Companion settings are available on loopback only",
        ));
    }
    authorize(ctx, headers, Some(peer))
}

fn relay_connection_state_label(state: &RelayConnectionState) -> &'static str {
    match state {
        RelayConnectionState::Disabled => "disabled",
        RelayConnectionState::Connecting => "connecting",
        RelayConnectionState::Connected => "connected",
        RelayConnectionState::Error => "error",
    }
}

fn ensure_desktop_id_persisted(daemon: &DaemonState) -> Result<String, String> {
    let mut config = daemon
        .app
        .config
        .lock()
        .map_err(|error| error.to_string())?;
    let had_desktop_id = config
        .companion
        .desktop_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());
    let desktop_id = get_or_create_desktop_id(&mut config.companion);
    if !had_desktop_id {
        crate::config::save_config(&daemon.roots, &config)?;
    }
    Ok(desktop_id)
}

/// 监听器当前实际绑定的端口。带 `--port` 覆盖启动时(dev / 冒烟)它与
/// `config.companion.port` 不同 —— 状态与重绑都必须用真正在听的这个端口。
async fn live_listen_port(daemon: &DaemonState) -> u16 {
    let companion_state = &daemon.companion;
    let state_port = *companion_state.inner.port.read().await;
    if companion_state.inner.is_loopback_running() && state_port != 0 {
        return state_port;
    }
    // 配置锁中毒只可能是别处 panic 的余波;这时退回状态里记的端口,好过把 0
    // 当成端口去绑一个随机端口。
    daemon
        .app
        .config
        .lock()
        .ok()
        .map(|config| config.companion.port)
        .unwrap_or(state_port)
}

/// 组装前端 `CompanionStatus` 形状。配对码只在暴露开启时给出,并沿用
/// config 里的持久化值(未过期就复用,过期/缺失则新建并落盘)。
async fn build_companion_status(daemon: &DaemonState) -> Result<CompanionStatus, String> {
    let companion_state = &daemon.companion;
    let desktop_id = ensure_desktop_id_persisted(daemon)?;
    let daemon_ready = companion_state.inner.is_loopback_running();
    let lan_exposed = companion_state.inner.is_lan_exposed();
    let live_port = live_listen_port(daemon).await;
    let detected_lan_ip = local_ip().ok().map(|ip| ip.to_string());

    let (
        relay_config,
        paired_devices,
        lan_ip,
        pairing_code,
        pairing_code_expires_at,
        should_save_config,
    ) = {
        let mut config = daemon
            .app
            .config
            .lock()
            .map_err(|error| error.to_string())?;
        let relay_config = config.companion.relay.clone();
        let paired_devices = {
            let db = daemon.app.db.lock().map_err(|error| error.to_string())?;
            operations::list_paired_devices(&db).map_err(|error| error.to_string())?
        };
        let previous_lan_ip = config.companion.last_lan_ip.clone();
        let lan_ip = resolve_lan_ip(&mut config.companion, detected_lan_ip);
        let mut should_save_config = previous_lan_ip != config.companion.last_lan_ip;
        let (pairing_code, pairing_code_expires_at) = if lan_exposed {
            let previous_code = config.companion.pairing_code.clone();
            let code = ensure_persisted_pairing_code(companion_state, &mut config.companion);
            if config.companion.pairing_code != previous_code {
                should_save_config = true;
            }
            (Some(code), config.companion.pairing_code_expires_at.clone())
        } else {
            (None, None)
        };
        (
            relay_config,
            paired_devices,
            lan_ip,
            pairing_code,
            pairing_code_expires_at,
            should_save_config,
        )
    };

    if should_save_config {
        let config = daemon
            .app
            .config
            .lock()
            .map_err(|error| error.to_string())?;
        crate::config::save_config(&daemon.roots, &config)?;
    }

    let relay_state = companion_state.relay_state().get().await;
    let desktop_public_key_b64 = companion_state.e2ee_public_key_b64().await;
    let daemon_error = companion_state.daemon_error().await;

    Ok(CompanionStatus {
        enabled: lan_exposed,
        daemon_ready,
        daemon_error,
        port: live_port,
        desktop_id: Some(desktop_id),
        lan_ip,
        pairing_code,
        pairing_code_expires_at,
        paired_devices,
        relay: CompanionRelayStatus {
            enabled: relay_config.enabled,
            endpoint: relay_config.endpoint,
            use_tls: relay_config.use_tls,
            connection_state: relay_connection_state_label(&relay_state).to_string(),
            desktop_public_key_b64,
        },
    })
}

async fn companion_status(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<CompanionStatus>, ApiError> {
    authorize_companion_admin(&ctx, &headers, peer)?;
    build_companion_status(&ctx.daemon)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

/// 开/关移动伴侣:只改「局域网 + 中继暴露」。开启时把服务重绑到配置的
/// 局域网地址并拉起中继;关闭时停中继、清配对码、退回回环监听。
///
/// 重绑走后台任务:重绑会优雅关闭当前监听器,而这条 HTTP 请求正跑在它上面,
/// 同步重绑等于等自己排空(实测卡满 5s 超时),在不能同端口二次绑定的平台
/// 上更会因为端口未释放而直接失败。这里先落配置与意图状态并立刻返回,重绑
/// 结果由 `daemon_error` 与后续状态轮询反映。
async fn set_companion_enabled(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SetEnabledRequest>,
) -> Result<Json<CompanionStatus>, ApiError> {
    authorize_companion_admin(&ctx, &headers, peer)?;
    let daemon = ctx.daemon.clone();
    let companion_state = daemon.companion.clone();
    let enabled = body.enabled;
    let port = live_listen_port(&daemon).await;

    let listen_address = {
        let mut config = daemon
            .app
            .config
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        config.companion.enabled = enabled;
        let _ = get_or_create_desktop_id(&mut config.companion);
        if enabled {
            // 先备好配对码,开关的响应就能直接带上二维码内容。
            ensure_persisted_pairing_code(&companion_state, &mut config.companion);
        } else {
            clear_persisted_pairing_code(&mut config.companion);
        }
        crate::config::save_config(&daemon.roots, &config).map_err(ApiError::internal)?;
        config.companion.listen_address.clone()
    };

    if !enabled {
        crate::companion::relay::stop_relay_transport(&companion_state).await;
        companion_state.inner.clear_pairing_codes();
    }
    // 立刻表态:关闭后非回环请求马上被拒,不必等监听器真正退掉。
    companion_state.inner.set_lan_exposed(enabled);

    tokio::spawn(rebind_companion_listener(
        daemon.clone(),
        enabled,
        port,
        listen_address,
    ));

    build_companion_status(&daemon)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

/// 后台重绑监听器。失败时把开关收回并恢复回环监听,绝不把 daemon 留在
/// 「没人在听」的状态;失败原因留在 `daemon_error` 供 UI 展示。
async fn rebind_companion_listener(
    daemon: Arc<DaemonState>,
    expose_lan: bool,
    port: u16,
    listen_address: String,
) {
    let companion_state = daemon.companion.clone();
    let error =
        match start_daemon_server(daemon.clone(), port, expose_lan, listen_address.clone()).await {
            Ok(()) => return,
            Err(error) => error,
        };

    if !expose_lan {
        log::warn!(target: "companion", "Failed to rebind companion listener: {}", error);
        return;
    }

    log::warn!(
        target: "companion",
        "Failed to expose mobile companion on LAN: {}",
        error
    );
    {
        let mut config = match daemon.app.config.lock() {
            Ok(config) => config,
            Err(_) => return,
        };
        config.companion.enabled = false;
        clear_persisted_pairing_code(&mut config.companion);
        let _ = crate::config::save_config(&daemon.roots, &config);
    }
    companion_state.inner.set_lan_exposed(false);
    companion_state.inner.clear_pairing_codes();

    match start_daemon_server(daemon.clone(), port, false, listen_address).await {
        Ok(()) => companion_state.set_daemon_error(Some(error)).await,
        Err(restore_error) => log::warn!(
            target: "companion",
            "Failed to restore loopback listener after exposure failure: {}",
            restore_error
        ),
    }
}

async fn refresh_companion_pairing_code(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<CompanionStatus>, ApiError> {
    authorize_companion_admin(&ctx, &headers, peer)?;
    let daemon = ctx.daemon.clone();
    if !daemon.companion.inner.is_lan_exposed() {
        return Err(ApiError::forbidden("Companion server is not enabled"));
    }
    {
        let mut config = daemon
            .app
            .config
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        refresh_persisted_pairing_code(&daemon.companion, &mut config.companion);
        crate::config::save_config(&daemon.roots, &config).map_err(ApiError::internal)?;
    }
    build_companion_status(&daemon)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn set_companion_relay_enabled(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SetRelayEnabledRequest>,
) -> Result<Json<CompanionStatus>, ApiError> {
    authorize_companion_admin(&ctx, &headers, peer)?;
    let daemon = ctx.daemon.clone();
    set_relay_enabled(&daemon, &daemon.companion, body.enabled)
        .await
        .map_err(ApiError::bad_request)?;
    build_companion_status(&daemon)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn set_companion_relay_config(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SetRelayConfigRequest>,
) -> Result<Json<CompanionStatus>, ApiError> {
    authorize_companion_admin(&ctx, &headers, peer)?;
    let daemon = ctx.daemon.clone();
    set_relay_config(&daemon, &daemon.companion, body.endpoint, body.use_tls)
        .await
        .map_err(ApiError::bad_request)?;
    build_companion_status(&daemon)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::local_daemon_token::{
        ensure_local_daemon_token, read_local_daemon_token,
    };
    use crate::companion::server::server_tests::{
        assemble_test_app, body_text, lan_peer, loopback_peer, post_json, respond, TestApp,
    };
    use axum::http::StatusCode;

    fn companion_post_paths() -> Vec<(&'static str, serde_json::Value)> {
        vec![
            (
                "/api/companion/enabled",
                serde_json::json!({ "enabled": true }),
            ),
            ("/api/companion/pairing-code/refresh", serde_json::json!({})),
            (
                "/api/companion/relay/enabled",
                serde_json::json!({ "enabled": true }),
            ),
            (
                "/api/companion/relay/config",
                serde_json::json!({ "endpoint": "relay.example:443", "useTls": true }),
            ),
        ]
    }

    fn issue_token(app: &TestApp) -> String {
        let token = ensure_local_daemon_token(&app.daemon.app.app_data_dir, true).expect("token");
        read_local_daemon_token(&app.daemon.app.app_data_dir).expect("persisted token");
        token
    }

    fn current_token(app: &TestApp) -> String {
        // 每次监听器重启都会轮换 Local Daemon Token,重启后要重新读盘。
        read_local_daemon_token(&app.daemon.app.app_data_dir).expect("persisted token")
    }

    fn bearer(token: &str) -> String {
        format!("Bearer {token}")
    }

    async fn status_with_token(app: &TestApp, token: &str) -> CompanionStatus {
        let header = bearer(token);
        let response = respond(
            app,
            "/api/companion/status",
            loopback_peer(),
            &[("authorization", header.as_str())],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "status 应可查询");
        serde_json::from_str(&body_text(response).await).expect("CompanionStatus JSON")
    }

    /// 回归:管理面路由没落地时 POST 会掉进 SPA 静态兜底变成 405,GET 会拿到
    /// 一份 text/html 的 index.html —— UI 于是报 `Daemon request failed: 405`。
    #[tokio::test]
    async fn companion_admin_routes_are_mounted_and_require_a_token() {
        let app = assemble_test_app(&[]).await;

        for (path, body) in companion_post_paths() {
            let response = post_json(&app, path, loopback_peer(), &[], body).await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "POST {path} 应命中真实路由并拒绝无令牌调用"
            );
        }

        let status = respond(&app, "/api/companion/status", loopback_peer(), &[]).await;
        assert_eq!(status.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            status
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json"),
            "GET /api/companion/status 不再回退成 SPA index.html"
        );
    }

    #[tokio::test]
    async fn companion_status_reports_disabled_state_shape() {
        let app = assemble_test_app(&[]).await;
        let token = issue_token(&app);
        let status = status_with_token(&app, &token).await;

        assert!(!status.enabled, "默认不暴露局域网");
        assert!(!status.daemon_ready, "测试未启动监听器");
        assert_eq!(
            status.port,
            crate::config::types::CompanionConfig::default().port
        );
        assert!(status.pairing_code.is_none(), "未暴露时不发配对码");
        assert!(status.pairing_code_expires_at.is_none());
        assert!(status.paired_devices.is_empty());
        assert!(status.desktop_id.is_some(), "状态查询会补齐 desktop_id");
        assert!(!status.relay.enabled);
        assert_eq!(status.relay.connection_state, "disabled");
        assert!(
            status.relay.desktop_public_key_b64.is_none(),
            "中继未启用时不对外给 E2EE 公钥"
        );
    }

    #[tokio::test]
    async fn companion_status_surfaces_the_e2ee_public_key() {
        let app = assemble_test_app(&[]).await;
        let token = issue_token(&app);
        app.daemon
            .companion
            .set_e2ee_public_key_b64("desktop-key".to_string())
            .await;

        let status = status_with_token(&app, &token).await;
        assert_eq!(
            status.relay.desktop_public_key_b64.as_deref(),
            Some("desktop-key")
        );
    }

    /// 配对手机即便持有有效配对令牌,也不能远程开关桌面暴露策略。
    #[tokio::test]
    async fn companion_admin_routes_reject_non_loopback_peers() {
        let app = assemble_test_app(&["http://192.168.1.8:9240"]).await;
        let token = issue_token(&app);
        let header = bearer(&token);
        let same_origin = [
            ("authorization", header.as_str()),
            ("host", "192.168.1.8:9240"),
            ("origin", "http://192.168.1.8:9240"),
        ];

        let status = respond(&app, "/api/companion/status", lan_peer(), &same_origin).await;
        assert_eq!(status.status(), StatusCode::FORBIDDEN);
        assert!(body_text(status).await.contains("loopback only"));

        let enabled = post_json(
            &app,
            "/api/companion/enabled",
            lan_peer(),
            &same_origin,
            serde_json::json!({ "enabled": true }),
        )
        .await;
        assert_eq!(enabled.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn pairing_code_only_exists_while_lan_exposed() {
        let app = assemble_test_app(&[]).await;
        let token = issue_token(&app);
        let header = bearer(&token);

        let exposed = post_json(
            &app,
            "/api/companion/pairing-code/refresh",
            loopback_peer(),
            &[("authorization", header.as_str())],
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            exposed.status(),
            StatusCode::FORBIDDEN,
            "未暴露时刷新配对码应被拒绝"
        );

        app.daemon.companion.inner.set_lan_exposed(true);
        let status = status_with_token(&app, &token).await;
        assert!(status.enabled);
        let code = status.pairing_code.expect("暴露时给出配对码");
        assert_eq!(code.len(), 6, "配对码是 6 位数字");
        assert!(code.chars().all(|ch| ch.is_ascii_digit()));
        assert!(status.pairing_code_expires_at.is_some());

        app.daemon.companion.inner.set_lan_exposed(false);
        let disabled = status_with_token(&app, &token).await;
        assert!(!disabled.enabled);
        assert!(disabled.pairing_code.is_none(), "关闭后不再给配对码");
    }

    /// 开关会真的重绑监听器:开启后局域网暴露,关闭后退回回环且清配对码。
    #[tokio::test]
    async fn toggling_companion_rebinds_listener() {
        let app = assemble_test_app(&[]).await;
        issue_token(&app);
        let port = free_port();
        {
            let mut config = app.daemon.app.config.lock().expect("config lock");
            config.companion.port = port;
            config.companion.listen_address = "127.0.0.1".to_string();
        }

        let header = bearer(&current_token(&app));
        let enabled = post_json(
            &app,
            "/api/companion/enabled",
            loopback_peer(),
            &[("authorization", header.as_str())],
            serde_json::json!({ "enabled": true }),
        )
        .await;
        assert_eq!(enabled.status(), StatusCode::OK, "开启应成功");
        let opened: CompanionStatus =
            serde_json::from_str(&body_text(enabled).await).expect("JSON");
        assert!(opened.enabled, "开启后状态为已暴露");
        assert!(opened.pairing_code.is_some());
        assert_eq!(opened.port, port, "状态报的是真实在听的端口");
        assert!(
            wait_for_listener(port).await,
            "开启后监听器应落在配置端口上"
        );
        let running = status_with_token(&app, &current_token(&app)).await;
        assert!(running.enabled && running.daemon_ready, "开启后监听器在跑");

        let header = bearer(&current_token(&app));
        let disabled = post_json(
            &app,
            "/api/companion/enabled",
            loopback_peer(),
            &[("authorization", header.as_str())],
            serde_json::json!({ "enabled": false }),
        )
        .await;
        assert_eq!(disabled.status(), StatusCode::OK, "关闭应成功");
        let closed: CompanionStatus =
            serde_json::from_str(&body_text(disabled).await).expect("JSON");
        assert!(!closed.enabled, "关闭后不再暴露");
        assert!(closed.pairing_code.is_none(), "关闭时清配对码");
        assert!(
            !app.daemon.companion.inner.is_lan_exposed(),
            "旧监听器的收尾任务不得把新状态抹错"
        );
        assert!(
            wait_for_listener(port).await,
            "关闭后回环监听器应重新在配置端口上"
        );
        let still_running = status_with_token(&app, &current_token(&app)).await;
        assert!(
            still_running.daemon_ready && !still_running.enabled,
            "关闭移动伴侣不停回环 Daemon"
        );
    }

    /// 重绑是后台任务:等端口真的可以 connect 再断言。
    async fn wait_for_listener(port: u16) -> bool {
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        false
    }

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind free port");
        listener.local_addr().expect("local addr").port()
    }
}
