use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::companion::actions::{
    interrupt_companion_session, respond_companion_permission, send_companion_message,
    send_companion_tool_response, update_companion_settings, CompanionSettingsUpdate,
};
use crate::companion::auth::{
    classify_local_daemon_token, local_daemon_device, LocalDaemonTokenDecision,
};
use crate::companion::browser_automation;
use crate::companion::config::build_mobile_bootstrap;
use crate::companion::context::build_composer_context;
use crate::companion::desktop_id::get_or_create_desktop_id;
use crate::companion::offer::build_pairing_offer;
use crate::companion::origin::{validate_web_origin, AllowedOrigins, WebOriginDecision};
use crate::companion::pairing::complete_pairing;
use crate::companion::routes_agent_runtime;
use crate::companion::routes_app_config;
use crate::companion::routes_control_plane;
use crate::companion::routes_extended;
use crate::companion::routes_history_import;
use crate::companion::routes_providers;
use crate::companion::routes_terminal;
use crate::companion::state::{CompanionBroadcastEvent, CompanionState};
use crate::config::types::AgentKind;
use crate::db::operations;

#[derive(Clone)]
pub(crate) struct ServerContext {
    pub daemon: std::sync::Arc<crate::daemon::DaemonState>,
    /// 网页端放行的跨源 Origin(启动时解析,修改随 server 重启生效)。
    pub(crate) web_origin_allowlist: std::sync::Arc<AllowedOrigins>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimRequest {
    code: String,
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimResponse {
    token: String,
    device_id: String,
}

/// 回环浏览器申请本机配对(工单 02):仅 loopback 可调用,由壳/CLI 确认。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairRequest {
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairStartResponse {
    request_id: String,
    code: String,
    name: String,
    desktop_id: String,
    expires_at: String,
}

/// 壳/CLI 的确认决定:`approve = false` 即拒绝。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairDecisionRequest {
    request_id: String,
    approve: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairStatusResponse {
    request_id: String,
    status: String,
    desktop_id: String,
    token: Option<String>,
    device_id: Option<String>,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairPendingResponse {
    requests: Vec<LocalPairPendingEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPairPendingEntry {
    request_id: String,
    code: String,
    name: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    prompt: String,
    input_payload: Option<serde_json::Value>,
    delivery: Option<String>,
    request_id: Option<String>,
}

fn has_sendable_input(prompt: &str, input_payload: Option<&serde_json::Value>) -> bool {
    if !prompt.trim().is_empty() {
        return true;
    }
    let Some(payload) = input_payload else {
        return false;
    };
    if payload
        .get("text")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return true;
    }
    ["attachments", "images"].iter().any(|field| {
        payload
            .get(*field)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSettingsRequest {
    agent_kind: String,
    provider_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    permission_config: serde_json::Value,
    plan_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    title: String,
    agent_kind: Option<String>,
    project_id: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    permission_config: Option<String>,
    plan_mode: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInputRespondRequest {
    session_id: String,
    tool_use_id: String,
    response: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRespondRequest {
    session_id: String,
    request_id: String,
    response: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEventsQuery {
    after: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionTimelineQuery {
    direction: Option<String>,
    cursor: Option<i64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsQuery {
    token: String,
    /// 缺省/空 = 控制面连接(接收 browser-automation-request 等控制事件)。
    session_id: Option<String>,
}

pub async fn start_daemon_server(
    daemon: std::sync::Arc<crate::daemon::DaemonState>,
    port: u16,
    expose_lan: bool,
    lan_listen_address: String,
) -> Result<(), String> {
    let companion_state = daemon.companion.clone();
    let result = start_daemon_server_body(daemon, port, expose_lan, lan_listen_address).await;
    if let Err(error) = &result {
        companion_state.set_daemon_error(Some(error.clone())).await;
    } else {
        companion_state.set_daemon_error(None).await;
    }
    result
}

async fn start_daemon_server_body(
    daemon: std::sync::Arc<crate::daemon::DaemonState>,
    port: u16,
    expose_lan: bool,
    lan_listen_address: String,
) -> Result<(), String> {
    let companion_state = daemon.companion.clone();
    let _lifecycle_guard = companion_state.inner.lifecycle_lock.lock().await;

    stop_daemon_server_inner(&companion_state).await?;

    let app_data_dir = daemon.app.app_data_dir.clone();
    let _token =
        crate::companion::local_daemon_token::ensure_local_daemon_token(&app_data_dir, true)?;

    {
        let mut stored_port = companion_state.inner.port.write().await;
        *stored_port = port;
    }

    let (web_static_override, web_origin_allowlist) = read_web_serve_config(&daemon)?;
    let static_dir = resolve_static_dir(&daemon, web_static_override);
    let ctx = ServerContext {
        daemon: daemon.clone(),
        web_origin_allowlist: std::sync::Arc::new(web_origin_allowlist),
    };
    let router = build_router(ctx, static_dir);

    let bind_address = if expose_lan {
        lan_listen_address.trim()
    } else {
        "127.0.0.1"
    };
    let addr = parse_listen_addr(bind_address, port)?;
    let listener = bind_listener_with_retry(addr).await?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (stopped_tx, stopped_rx) = oneshot::channel::<()>();
    {
        let mut guard = companion_state.inner.shutdown_tx.lock().unwrap();
        *guard = Some(shutdown_tx);
        let mut waiter = companion_state.inner.stopped_waiter.lock().unwrap();
        *waiter = Some(stopped_rx);
    }

    companion_state.inner.set_loopback_running(true);
    companion_state.inner.set_lan_exposed(expose_lan);
    info!(
        target: "companion",
        "Daemon server listening on {} (lan_exposed={})",
        addr,
        expose_lan
    );

    if expose_lan {
        if let Err(error) =
            crate::companion::relay::sync_relay_transport(&daemon, &companion_state).await
        {
            warn!(target: "companion", "Failed to start relay transport: {}", error);
        }
    }

    let companion_for_shutdown = companion_state.inner.clone();
    tokio::spawn(async move {
        let result = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await;
        if let Err(error) = result {
            warn!(target: "companion", "Daemon server stopped with error: {}", error);
        }
        companion_for_shutdown.set_loopback_running(false);
        companion_for_shutdown.set_lan_exposed(false);
        let _ = stopped_tx.send(());
    });

    Ok(())
}

pub async fn stop_daemon_for_state(companion_state: &CompanionState) -> Result<(), String> {
    let _lifecycle_guard = companion_state.inner.lifecycle_lock.lock().await;
    stop_daemon_server_inner(companion_state).await
}

async fn stop_daemon_server_inner(companion_state: &CompanionState) -> Result<(), String> {
    crate::companion::relay::stop_relay_transport(companion_state).await;
    let shutdown_tx = companion_state.inner.shutdown_tx.lock().unwrap().take();
    let stopped_rx = companion_state.inner.stopped_waiter.lock().unwrap().take();
    if let Some(tx) = shutdown_tx {
        let _ = tx.send(());
    }
    if let Some(rx) = stopped_rx {
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => {
                warn!(
                    target: "companion",
                    "Companion server shutdown did not complete in time; waiting before rebind"
                );
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    companion_state.inner.set_loopback_running(false);
    companion_state.inner.set_lan_exposed(false);
    Ok(())
}

async fn bind_listener_with_retry(addr: SocketAddr) -> Result<tokio::net::TcpListener, String> {
    const MAX_ATTEMPTS: usize = 6;
    let mut last_error = String::new();

    for attempt in 0..MAX_ATTEMPTS {
        match bind_reusable_listener(addr).await {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                last_error = error;
                if attempt + 1 < MAX_ATTEMPTS {
                    let delay_ms = 150_u64 * (attempt as u64 + 1);
                    warn!(
                        target: "companion",
                        "Companion bind attempt {} failed on {}: {}; retrying in {}ms",
                        attempt + 1,
                        addr,
                        last_error,
                        delay_ms
                    );
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }

    Err(format!(
        "Failed to bind companion server on port {}: {}",
        addr.port(),
        last_error
    ))
}

async fn bind_reusable_listener(addr: SocketAddr) -> Result<tokio::net::TcpListener, String> {
    let domain = if addr.is_ipv6() {
        socket2::Domain::IPV6
    } else {
        socket2::Domain::IPV4
    };
    let socket = socket2::Socket::new(domain, socket2::Type::STREAM, None)
        .map_err(|error| error.to_string())?;
    socket
        .set_reuse_address(true)
        .map_err(|error| error.to_string())?;
    socket
        .bind(&addr.into())
        .map_err(|error| error.to_string())?;
    socket.listen(1024).map_err(|error| error.to_string())?;
    socket
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let std_listener: std::net::TcpListener = socket.into();
    tokio::net::TcpListener::from_std(std_listener).map_err(|error| error.to_string())
}

fn build_router(ctx: ServerContext, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/pair/offer", get(pair_offer))
        .route("/pair/claim", post(pair_claim))
        .route("/pair/local/request", post(pair_local_request))
        .route("/pair/local/pending", get(pair_local_pending))
        .route("/pair/local/decision", post(pair_local_decision))
        .route("/pair/local/request/{request_id}", get(pair_local_status))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{session_id}/events", get(session_events))
        .route("/sessions/{session_id}/timeline", get(session_timeline))
        .route("/sessions/{session_id}/state", get(session_runtime_state))
        .route("/sessions/{session_id}/messages", post(send_message))
        .route(
            "/sessions/{session_id}/composer-context",
            get(composer_context),
        )
        .route(
            "/sessions/{session_id}/settings",
            patch(update_session_settings),
        )
        .route("/sessions/{session_id}/interrupt", post(interrupt_session))
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{project_id}",
            patch(rename_project).delete(delete_project),
        )
        .route("/bootstrap", get(bootstrap))
        .route("/permissions/respond", post(permission_respond))
        .route("/interactive/user-input", post(user_input_respond))
        .route("/ws", get(ws_handler));

    let api = routes_extended::extend_api_router(api);
    let api = routes_agent_runtime::extend_api_router(api);
    let api = routes_history_import::extend_api_router(api);
    let api = routes_app_config::extend_api_router(api);
    let api = routes_control_plane::extend_api_router(api);
    let api = routes_providers::extend_api_router(api);
    let api = routes_terminal::extend_api_router(api);
    let api = browser_automation::extend_api_router(api);

    let mut router = Router::new().nest("/api", api);
    if let Some(static_dir) = static_dir {
        let index_file = static_dir.join("index.html");
        // SPA 回退用 fallback 而非 not_found_service:后者会把回退响应状态强制
        // 改写为 404,深链刷新时前端拿到的入口页会带 404 状态。
        let static_service = ServeDir::new(static_dir).fallback(ServeFile::new(index_file));
        router = router.fallback_service(static_service);
    }

    router
        .layer(middleware::from_fn_with_state(
            ctx.clone(),
            origin_guard_middleware,
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(CorsLayer::permissive())
        .with_state(ctx)
}

async fn origin_guard_middleware(
    State(ctx): State<ServerContext>,
    request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    if validate_web_origin(peer, request.headers(), &ctx.web_origin_allowlist)
        == WebOriginDecision::Reject
    {
        return ApiError::forbidden("Request origin is not allowed").into_response();
    }
    next.run(request).await
}

/// 读取网页端托管配置(静态目录覆盖 + 放行 Origin 列表),一次锁内快照;
/// 修改随 server 重启生效(与监听地址一致)。
fn read_web_serve_config(
    daemon: &crate::daemon::DaemonState,
) -> Result<(Option<PathBuf>, AllowedOrigins), String> {
    let config = daemon
        .app
        .config
        .lock()
        .map_err(|error| format!("config lock poisoned: {error}"))?;
    let static_dir_override = config
        .companion
        .web_static_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok((
        static_dir_override,
        AllowedOrigins::parse(&config.companion.web_allowed_origins),
    ))
}

/// 浏览器形态静态目录解析:配置覆盖(目录需存在) → 打包资源 dist-web →
/// 源码树 dist-web(仅开发)。工单 04 起没有移动端产物兜底 —— 统一前端是
/// 唯一产物,解析不到就不给浏览器入口(API 仍照常工作)。
fn resolve_static_dir(
    daemon: &crate::daemon::DaemonState,
    override_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        if dir.exists() {
            return Some(dir);
        }
        warn!(
            target: "companion",
            "Configured web_static_dir does not exist, falling back: {}",
            dir.display()
        );
    }
    daemon.roots.web_static_dir()
}

async fn health(State(ctx): State<ServerContext>) -> impl IntoResponse {
    let companion_state = ctx.daemon.companion.clone();
    Json(serde_json::json!({
        "ok": companion_state.inner.is_loopback_running(),
        "loopback": companion_state.inner.is_loopback_running(),
        "lanExposed": companion_state.inner.is_lan_exposed(),
        "version": crate::daemon::DAEMON_VERSION,
    }))
}

async fn pair_offer(
    State(ctx): State<ServerContext>,
) -> Result<Json<crate::companion::offer::CompanionPairingOffer>, ApiError> {
    let companion_state = ctx.daemon.companion.clone();
    if !companion_state.inner.is_lan_exposed() {
        return Err(ApiError::forbidden("Mobile companion is not enabled"));
    }
    let (desktop_id, port, relay) = resolve_desktop_identity(&ctx)?;

    let lan_ip = local_ip_address::local_ip().ok().map(|ip| ip.to_string());
    let desktop_public_key_b64 = companion_state.e2ee_public_key_b64().await;
    build_pairing_offer(
        &companion_state,
        desktop_id,
        port,
        lan_ip,
        Some(relay),
        desktop_public_key_b64,
    )
    .map(Json)
    .map_err(ApiError::bad_request)
}

/// desktop_id / 端口 / 中继配置的解析(必要时创建 desktop_id 并落盘):
/// QR 配对与回环简化配对共用同一条身份链。
fn resolve_desktop_identity(
    ctx: &ServerContext,
) -> Result<(String, u16, crate::config::types::CompanionRelayConfig), ApiError> {
    let app_state = ctx.daemon.app.clone();
    let mut config = app_state
        .config
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let had_desktop_id = config
        .companion
        .desktop_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());
    let desktop_id = get_or_create_desktop_id(&mut config.companion);
    let port = config.companion.port;
    let relay = config.companion.relay.clone();
    if !had_desktop_id {
        crate::config::save_config(&ctx.daemon.roots, &config).map_err(ApiError::internal)?;
    }
    Ok((desktop_id, port, relay))
}

fn random_local_pairing_code() -> String {
    use rand::Rng;
    (0..6)
        .map(|_| rand::thread_rng().gen_range(0..10).to_string())
        .collect()
}

fn require_loopback_peer(peer: SocketAddr) -> Result<(), ApiError> {
    if is_loopback_peer(Some(peer)) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "Local browser pairing is available on loopback only",
        ))
    }
}

/// 同机浏览器申请一次本机配对:生成确认码并把请求推给桌面壳(或由 CLI 列出)。
async fn pair_local_request(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<LocalPairRequest>,
) -> Result<Json<LocalPairStartResponse>, ApiError> {
    require_loopback_peer(peer)?;
    let companion_state = ctx.daemon.companion.clone();
    let (desktop_id, _port, _relay) = resolve_desktop_identity(&ctx)?;
    let record = companion_state.inner.local_pairing.create(
        uuid::Uuid::new_v4().to_string(),
        random_local_pairing_code(),
        body.name.as_deref(),
    );
    // 壳是同一台机器上的可信呈现面;没有壳(headless CLI 运行)时事件被丢弃,
    // 浏览器仍在轮询,CLI 可经 /api/pair/local/pending 发现并确认。
    ctx.daemon.ui_events.emit(
        "web-pairing-request",
        serde_json::json!({
            "requestId": record.id,
            "code": record.code,
            "name": record.name,
            "expiresAt": record.expires_at.to_rfc3339(),
            "desktopId": desktop_id,
        }),
    );
    Ok(Json(LocalPairStartResponse {
        request_id: record.id,
        code: record.code,
        name: record.name,
        desktop_id,
        expires_at: record.expires_at.to_rfc3339(),
    }))
}

/// 浏览器轮询配对结果:批准后一次性拿到 Pairing Token(仍限 loopback 来源)。
async fn pair_local_status(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(request_id): Path<String>,
) -> Result<Json<LocalPairStatusResponse>, ApiError> {
    require_loopback_peer(peer)?;
    let (desktop_id, _port, _relay) = resolve_desktop_identity(&ctx)?;
    let record = ctx
        .daemon
        .companion
        .inner
        .local_pairing
        .get(&request_id)
        .ok_or_else(|| ApiError::not_found("Unknown pairing request"))?;
    let status = record.status_at(chrono::Utc::now());
    Ok(Json(LocalPairStatusResponse {
        request_id: record.id,
        status: status.as_str().to_string(),
        desktop_id,
        token: if status == crate::companion::local_pairing::LocalPairingStatus::Approved {
            record.token.clone()
        } else {
            None
        },
        device_id: if status == crate::companion::local_pairing::LocalPairingStatus::Approved {
            record.device_id.clone()
        } else {
            None
        },
        expires_at: record.expires_at.to_rfc3339(),
    }))
}

/// 壳/CLI 的确认面:需要既有鉴权(Local Daemon Token / 已配对设备)。
async fn pair_local_pending(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<LocalPairPendingResponse>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let pending = ctx
        .daemon
        .companion
        .inner
        .local_pairing
        .pending()
        .into_iter()
        .map(|record| LocalPairPendingEntry {
            request_id: record.id,
            code: record.code,
            name: record.name,
            created_at: record.created_at.to_rfc3339(),
            expires_at: record.expires_at.to_rfc3339(),
        })
        .collect();
    Ok(Json(LocalPairPendingResponse { requests: pending }))
}

async fn pair_local_decision(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LocalPairDecisionRequest>,
) -> Result<Json<LocalPairStatusResponse>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let (desktop_id, _port, _relay) = resolve_desktop_identity(&ctx)?;
    let companion_state = ctx.daemon.companion.clone();
    let registry = &companion_state.inner.local_pairing;

    let record = if body.approve {
        let app_state = ctx.daemon.app.clone();
        let paired =
            complete_pairing(&app_state, Some("Local Browser")).map_err(ApiError::internal)?;
        registry
            .approve(&body.request_id, paired.device_id, paired.token)
            .map_err(ApiError::conflict)?
    } else {
        registry
            .deny(&body.request_id)
            .map_err(ApiError::conflict)?
    };

    let status = record.status_at(chrono::Utc::now());
    Ok(Json(LocalPairStatusResponse {
        request_id: record.id,
        status: status.as_str().to_string(),
        desktop_id,
        token: None,
        device_id: record.device_id.clone(),
        expires_at: record.expires_at.to_rfc3339(),
    }))
}

async fn pair_claim(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<PairClaimRequest>,
) -> Result<Json<PairClaimResponse>, ApiError> {
    let companion_state = ctx.daemon.companion.clone();
    if !is_loopback_peer(Some(peer)) && !companion_state.inner.is_lan_exposed() {
        return Err(ApiError::forbidden("Mobile companion is not enabled"));
    }
    // 配对码随二维码下发，扫码即自动 claim：校验但不作废，
    // 二维码本身 5 分钟过期，窗口内允许多次尝试（PWA 刷新/重试）。
    if !companion_state.validate_pairing_code(&body.code) {
        return Err(ApiError::bad_request("Invalid or expired pairing code"));
    }

    let app_state = ctx.daemon.app.clone();
    let result = complete_pairing(&app_state, body.name.as_deref()).map_err(ApiError::internal)?;
    Ok(Json(PairClaimResponse {
        token: result.token,
        device_id: result.device_id,
    }))
}

async fn list_sessions(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Vec<operations::Session>>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let sessions =
        operations::get_all_sessions(&db).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(sessions))
}

async fn create_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let agent_kind = AgentKind::from_str(body.agent_kind.as_deref().unwrap_or("claude_code"))
        .map_err(ApiError::bad_request)?;
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let session = match body.project_id.as_deref() {
        Some(project_id) => operations::create_session_for_project_with_permissions(
            &db,
            &body.title,
            agent_kind,
            body.mode.as_deref().unwrap_or("chat"),
            project_id,
            body.permission_config.as_deref(),
            body.plan_mode.as_deref(),
            body.model.as_deref(),
        ),
        None => operations::create_session_with_mode_and_permissions(
            &db,
            &body.title,
            agent_kind,
            body.mode.as_deref().unwrap_or("chat"),
            body.permission_config.as_deref(),
            body.plan_mode.as_deref(),
            body.model.as_deref(),
        ),
    }
    .map_err(|error| ApiError::internal(error.to_string()))?;

    if let (Some(provider_id), Some(model)) = (body.provider_id.as_deref(), body.model.as_deref()) {
        operations::update_session_provider(
            &db,
            &session.id,
            Some(provider_id),
            model,
            body.reasoning_effort.as_deref(),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    } else if let Some(reasoning_effort) = body.reasoning_effort.as_deref() {
        operations::update_session_reasoning_effort(&db, &session.id, reasoning_effort)
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }

    let session = operations::get_session(&db, &session.id)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .unwrap_or(session);
    Ok(Json(session))
}

async fn session_events(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<SessionEventsQuery>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let after = query.after.unwrap_or(-1);
    if after < 0 {
        let page = read_session_timeline_page(
            &ctx,
            &session_id,
            SessionTimelineQuery {
                direction: Some("tail".to_string()),
                cursor: None,
                limit: None,
            },
        )?;
        return Ok(Json(page.events));
    }
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let events = operations::get_session_events_after(&db, &session_id, after)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(events))
}

async fn session_timeline(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<SessionTimelineQuery>,
) -> Result<Json<operations::SessionTimelinePage>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let page = read_session_timeline_page(&ctx, &session_id, query)?;
    Ok(Json(page))
}

fn read_session_timeline_page(
    ctx: &ServerContext,
    session_id: &str,
    query: SessionTimelineQuery,
) -> Result<operations::SessionTimelinePage, ApiError> {
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let direction = operations::parse_timeline_direction(query.direction.as_deref());
    let limit = query
        .limit
        .unwrap_or(operations::DEFAULT_SESSION_TIMELINE_LIMIT);
    operations::fetch_session_timeline(&db, session_id, direction, query.cursor, limit)
        .map_err(|error| ApiError::internal(error.to_string()))
}

async fn session_runtime_state(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let companion_state = ctx.daemon.companion.clone();
    Ok(Json(serde_json::json!({
        "running": companion_state.is_turn_active(&session_id),
    })))
}

async fn send_message(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SendMessageRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    if !has_sendable_input(&body.prompt, body.input_payload.as_ref()) {
        return Err(ApiError::bad_request("Prompt cannot be empty"));
    }
    send_companion_message(
        &ctx.daemon,
        &session_id,
        body.prompt.trim(),
        body.input_payload,
        body.delivery.as_deref(),
        body.request_id.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::ACCEPTED)
}

async fn composer_context(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<crate::companion::context::ComposerContext>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    build_composer_context(&app_state, &session_id)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

async fn update_session_settings(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionSettingsRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let agent_kind = AgentKind::from_str(&body.agent_kind).map_err(ApiError::bad_request)?;
    let session = update_companion_settings(
        &ctx.daemon,
        &session_id,
        CompanionSettingsUpdate {
            agent_kind,
            provider_id: body.provider_id,
            model: body.model,
            reasoning_effort: body.reasoning_effort,
            permission_config: body.permission_config,
            plan_mode: body.plan_mode,
        },
    )
    .await
    .map_err(|error| {
        if error.contains("正在运行") {
            ApiError::conflict(error)
        } else {
            ApiError::bad_request(error)
        }
    })?;
    Ok(Json(session))
}

async fn interrupt_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    interrupt_companion_session(&ctx.daemon, &session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_projects(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Vec<operations::Project>>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let projects =
        operations::get_all_projects(&db).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(projects))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRequest {
    name: String,
    path: String,
}

async fn create_project(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectRequest>,
) -> Result<Json<operations::Project>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let project = operations::create_project(&db, &body.name, &body.path)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(project))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameProjectRequest {
    name: String,
}

async fn rename_project(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(body): Json<RenameProjectRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::rename_project(&db, &project_id, &body.name)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_project(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::delete_project(&db, &project_id)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn bootstrap(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<crate::companion::config::MobileBootstrap>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    Ok(Json(build_mobile_bootstrap(&app_state)))
}

async fn permission_respond(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PermissionRespondRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    respond_companion_permission(
        &ctx.daemon,
        &body.session_id,
        &body.request_id,
        body.response,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn user_input_respond(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<UserInputRespondRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    send_companion_tool_response(
        &ctx.daemon,
        &body.session_id,
        &body.tool_use_id,
        body.response,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<WsQuery>,
) -> Result<Response, ApiError> {
    authorize_token(&ctx, &query.token, Some(peer))?;
    let session_id = control_session_id(query.session_id.as_deref());
    let upgraded = match session_id {
        Some(session_id) => ws.on_upgrade(move |socket| handle_socket(socket, ctx, session_id)),
        // 无 session_id = 控制面连接(壳自动化客户端经此接收控制事件)。
        None => ws.on_upgrade(move |socket| handle_control_socket(socket, ctx)),
    };
    Ok(upgraded)
}

/// 会话 WS 带非空 session_id;缺省/空 = 控制面连接。
fn control_session_id(session_id: Option<&str>) -> Option<String> {
    session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn handle_socket(mut socket: WebSocket, ctx: ServerContext, session_id: String) {
    let companion_state = ctx.daemon.companion.clone();
    let mut rx = companion_state.inner.event_tx.subscribe();

    let initial_events = {
        let app_state = ctx.daemon.app.clone();
        app_state
            .db
            .lock()
            .ok()
            .and_then(|db| {
                operations::fetch_session_timeline(
                    &db,
                    &session_id,
                    operations::TimelineDirection::Tail,
                    None,
                    operations::DEFAULT_SESSION_TIMELINE_LIMIT,
                )
                .ok()
            })
            .map(|page| page.events)
            .unwrap_or_default()
    };

    for event in initial_events {
        let payload =
            serde_json::json!({ "type": "event", "sessionId": session_id, "event": event });
        if socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
    let state_payload = serde_json::json!({
        "type": "state",
        "sessionId": session_id,
        "running": companion_state.is_turn_active(&session_id),
    });
    if socket
        .send(Message::Text(state_payload.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) if socket
                        .send(Message::Pong(payload.clone()))
                        .await
                        .is_err() =>
                    {
                        break;
                    }
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(CompanionBroadcastEvent { session_id: event_session_id, event }) if event_session_id == session_id => {
                        let payload = serde_json::json!({ "type": "event", "sessionId": session_id, "event": event });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                            break;
                        }
                        let state_payload = serde_json::json!({
                            "type": "state",
                            "sessionId": session_id,
                            "running": companion_state.is_turn_active(&session_id),
                        });
                        if socket
                            .send(Message::Text(state_payload.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

/// 控制面 WS(工单 08):无 session_id 的 /ws 连接。先回 hello 供客户端确认
/// 订阅就绪,随后只转发 session_id 为空的控制事件(如 browser-automation-request);
/// 会话事件不下发(壳不是会话客户端)。
async fn handle_control_socket(mut socket: WebSocket, ctx: ServerContext) {
    let companion_state = ctx.daemon.companion.clone();
    let mut rx = companion_state.inner.event_tx.subscribe();

    let hello = serde_json::json!({ "type": "hello", "role": "control" });
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) if socket
                        .send(Message::Pong(payload.clone()))
                        .await
                        .is_err() =>
                    {
                        break;
                    }
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(CompanionBroadcastEvent { session_id, event }) if session_id.is_empty() => {
                        let payload = serde_json::json!({
                            "type": "event",
                            "sessionId": "",
                            "event": event,
                        });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

pub(crate) fn is_loopback_peer(peer: Option<SocketAddr>) -> bool {
    match peer {
        Some(addr) => addr.ip().is_loopback(),
        None => true,
    }
}

pub(crate) fn authorize(
    ctx: &ServerContext,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<(), ApiError> {
    authorize_device(ctx, headers, peer).map(|_| ())
}

fn authorize_device(
    ctx: &ServerContext,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<operations::PairedDevice, ApiError> {
    let token =
        extract_bearer_token(headers).ok_or_else(|| ApiError::unauthorized("Missing token"))?;
    authorize_token_device(ctx, &token, peer)
}

pub(crate) fn authorize_token(
    ctx: &ServerContext,
    token: &str,
    peer: Option<SocketAddr>,
) -> Result<(), ApiError> {
    authorize_token_device(ctx, token, peer).map(|_| ())
}

fn authorize_token_device(
    ctx: &ServerContext,
    token: &str,
    peer: Option<SocketAddr>,
) -> Result<operations::PairedDevice, ApiError> {
    let app_state = ctx.daemon.app.clone();
    let companion_state = ctx.daemon.companion.clone();
    let loopback = is_loopback_peer(peer);
    match classify_local_daemon_token(
        &app_state.app_data_dir,
        token,
        loopback,
        companion_state.inner.is_lan_exposed(),
    ) {
        LocalDaemonTokenDecision::AcceptLoopback => return Ok(local_daemon_device()),
        LocalDaemonTokenDecision::RejectCompanionDisabled => {
            return Err(ApiError::unauthorized("Mobile companion is not enabled"));
        }
        LocalDaemonTokenDecision::RejectNonLoopback => {
            return Err(ApiError::unauthorized(
                "Local daemon token is not accepted from non-loopback clients",
            ));
        }
        LocalDaemonTokenDecision::NotLocalToken => {}
    }

    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::verify_pairing_token(&db, token)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::unauthorized("Invalid token"))
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    pub(crate) fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }

    pub(crate) fn gateway_timeout(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::GATEWAY_TIMEOUT,
            message: message.into(),
        }
    }

    /// 状态码访问器(测试断言用)。
    #[cfg(test)]
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

use std::str::FromStr;

fn parse_listen_addr(listen_address: &str, port: u16) -> Result<SocketAddr, String> {
    let trimmed = listen_address.trim();
    if trimmed.is_empty() {
        return Ok(SocketAddr::from(([0, 0, 0, 0], port)));
    }
    if trimmed.contains(':') {
        return trimmed
            .parse::<SocketAddr>()
            .map_err(|error| error.to_string());
    }
    format!("{trimmed}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{has_sendable_input, SendMessageRequest, SessionSettingsRequest};

    #[test]
    fn accepts_attachment_only_mobile_messages() {
        let payload = serde_json::json!({
            "text": "",
            "attachments": [{
                "type": "image",
                "name": "screen.png",
                "mediaType": "image/png",
                "dataUrl": "data:image/png;base64,abc"
            }]
        });

        assert!(has_sendable_input("", Some(&payload)));
    }

    #[test]
    fn rejects_mobile_messages_without_text_or_model_attachments() {
        let payload = serde_json::json!({
            "text": "",
            "historyAttachments": [{
                "type": "image",
                "name": "screen.png"
            }]
        });

        assert!(!has_sendable_input("", Some(&payload)));
    }

    #[test]
    fn deserializes_mobile_message_input_payload() {
        let request: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "prompt": "请分析这张图",
            "inputPayload": {
                "text": "请分析这张图",
                "attachments": [{
                    "type": "image",
                    "name": "screen.png",
                    "mediaType": "image/png",
                    "dataUrl": "data:image/png;base64,abc"
                }]
            }
        }))
        .unwrap();

        assert_eq!(request.prompt, "请分析这张图");
        assert_eq!(
            request
                .input_payload
                .and_then(|payload| payload["attachments"][0]["name"]
                    .as_str()
                    .map(str::to_string)),
            Some("screen.png".to_string())
        );
    }

    #[test]
    fn deserializes_atomic_mobile_settings_request() {
        let request: SessionSettingsRequest = serde_json::from_value(serde_json::json!({
            "agentKind": "codex",
            "providerId": "provider-1",
            "model": "gpt-5",
            "reasoningEffort": "high",
            "permissionConfig": {
                "kind": "codex",
                "sandboxMode": "workspace-write"
            },
            "planMode": "off"
        }))
        .unwrap();

        assert_eq!(request.agent_kind, "codex");
        assert_eq!(request.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(request.permission_config["kind"], "codex");
        assert_eq!(request.plan_mode, "off");
    }

    #[test]
    fn extract_bearer_token_reads_authorization_header() {
        use super::extract_bearer_token;
        use axum::http::{HeaderMap, HeaderValue};

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer local-token"),
        );
        assert_eq!(
            extract_bearer_token(&headers).as_deref(),
            Some("local-token")
        );
    }

    #[test]
    fn extract_bearer_token_rejects_missing_header() {
        use super::extract_bearer_token;
        use axum::http::HeaderMap;

        let headers = HeaderMap::new();
        assert!(extract_bearer_token(&headers).is_none());
    }

    #[tokio::test]
    async fn stop_daemon_for_state_clears_loopback_and_lan_flags() {
        use super::stop_daemon_for_state;
        use crate::companion::CompanionState;

        let companion_state = CompanionState::new();
        companion_state.inner.set_loopback_running(true);
        companion_state.inner.set_lan_exposed(true);

        stop_daemon_for_state(&companion_state)
            .await
            .expect("stop without a running server should still clear flags");

        assert!(!companion_state.inner.is_loopback_running());
        assert!(!companion_state.inner.is_lan_exposed());
    }
}

#[cfg(test)]
mod headless_tests {
    use super::start_daemon_server;
    use crate::daemon::DaemonState;
    use crate::paths::PathRoots;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn headless_daemon_serves_loopback_health() {
        let temp = tempfile::tempdir().expect("tempdir");
        let daemon = Arc::new(
            DaemonState::assemble(
                PathRoots {
                    app_data_dir: temp.path().to_path_buf(),
                    resource_dir: None,
                },
                Arc::new(crate::daemon::NullUiEventSink),
            )
            .expect("assemble"),
        );

        // 找一个空闲端口:绑定后立即释放,再交给 daemon 绑定。
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);

        start_daemon_server(daemon.clone(), port, false, "127.0.0.1".to_string())
            .await
            .expect("start daemon server");

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        stream
            .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .expect("write request");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.expect("read response");
        let response = String::from_utf8_lossy(&buf).to_string();
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "loopback /api/health should answer 200 without a window, got: {response}"
        );

        super::stop_daemon_for_state(&daemon.companion)
            .await
            .expect("stop daemon");
    }
}

#[cfg(test)]
mod web_static_tests {
    use super::{build_router, ServerContext};
    use crate::daemon::DaemonState;
    use crate::paths::PathRoots;
    use axum::body::{to_bytes, Body};
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tower::ServiceExt;

    struct TestApp {
        router: axum::Router,
        _daemon_temp: tempfile::TempDir,
        _static_temp: tempfile::TempDir,
    }

    const INDEX_MARKER: &str = "<html>unified-frontend-index</html>";
    const ASSET_BODY: &str = "export const app = 'asset';";

    async fn assemble_test_app(allowed_origins: &[&str]) -> TestApp {
        assemble_test_app_with_static(allowed_origins, true).await
    }

    /// `with_static = false` 模拟没跑 `npm run build:web` 的机器。
    async fn assemble_test_app_with_static(allowed_origins: &[&str], with_static: bool) -> TestApp {
        let daemon_temp = tempfile::tempdir().expect("tempdir");
        let static_temp = tempfile::tempdir().expect("tempdir");
        if with_static {
            std::fs::write(static_temp.path().join("index.html"), INDEX_MARKER)
                .expect("write index");
            std::fs::create_dir_all(static_temp.path().join("assets")).expect("mkdir assets");
            std::fs::write(static_temp.path().join("assets/app.js"), ASSET_BODY)
                .expect("write asset");
        }

        let daemon = Arc::new(
            DaemonState::assemble(
                PathRoots {
                    app_data_dir: daemon_temp.path().to_path_buf(),
                    resource_dir: None,
                },
                Arc::new(crate::daemon::NullUiEventSink),
            )
            .expect("assemble"),
        );
        let router = build_router(
            ServerContext {
                daemon: daemon.clone(),
                web_origin_allowlist: std::sync::Arc::new(super::AllowedOrigins::parse(
                    &allowed_origins
                        .iter()
                        .map(|entry| entry.to_string())
                        .collect::<Vec<_>>(),
                )),
            },
            with_static.then(|| static_temp.path().to_path_buf()),
        );
        TestApp {
            router,
            _daemon_temp: daemon_temp,
            _static_temp: static_temp,
        }
    }

    fn loopback_peer() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 51000))
    }

    fn lan_peer() -> SocketAddr {
        SocketAddr::from(([192, 168, 1, 8], 51000))
    }

    async fn respond(
        app: &TestApp,
        uri: &str,
        peer: SocketAddr,
        headers: &[(&str, &str)],
    ) -> axum::response::Response {
        let mut builder = Request::builder().uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder.body(Body::empty()).expect("build request");
        request.extensions_mut().insert(ConnectInfo(peer));
        app.router.clone().oneshot(request).await.expect("oneshot")
    }

    async fn body_text(response: axum::response::Response) -> String {
        let bytes = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read body");
        String::from_utf8_lossy(&bytes).to_string()
    }

    async fn post_json(
        app: &TestApp,
        uri: &str,
        peer: SocketAddr,
        headers: &[(&str, &str)],
        body: serde_json::Value,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder
            .body(Body::from(body.to_string()))
            .expect("build request");
        request.extensions_mut().insert(ConnectInfo(peer));
        app.router.clone().oneshot(request).await.expect("oneshot")
    }

    #[tokio::test]
    async fn static_service_serves_index_assets_and_spa_fallback() {
        let app = assemble_test_app(&[]).await;

        for uri in ["/", "/sessions/some-id", "/deep/nested/link"] {
            let response = respond(&app, uri, loopback_peer(), &[]).await;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "GET {uri} should hit SPA"
            );
            assert_eq!(body_text(response).await, INDEX_MARKER, "GET {uri}");
        }

        let asset = respond(&app, "/assets/app.js", loopback_peer(), &[]).await;
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(body_text(asset).await, ASSET_BODY);
    }

    #[tokio::test]
    async fn static_responses_carry_no_store() {
        let app = assemble_test_app(&[]).await;
        let response = respond(&app, "/", loopback_peer(), &[]).await;
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store"),
            "网页端产物禁止中间缓存"
        );
    }

    /// 没有 `npm run build:web` 产物的机器:浏览器入口不存在(404),但
    /// 协议 API 照常工作——静态服务不是 API 的前置条件。
    #[tokio::test]
    async fn missing_web_build_keeps_api_alive_without_browser_entry() {
        let app = assemble_test_app_with_static(&[], false).await;

        let page = respond(&app, "/", loopback_peer(), &[]).await;
        assert_eq!(
            page.status(),
            StatusCode::NOT_FOUND,
            "没有统一前端产物时不再回退到任何旧构建"
        );
        let deep_link = respond(&app, "/sessions/some-id", loopback_peer(), &[]).await;
        assert_eq!(deep_link.status(), StatusCode::NOT_FOUND, "无 SPA 回退");

        let health = respond(&app, "/api/health", loopback_peer(), &[]).await;
        assert_eq!(
            health.status(),
            StatusCode::OK,
            "API 不依赖静态产物,daemon 仍可用"
        );
    }

    #[tokio::test]
    async fn loopback_requests_skip_origin_validation() {
        let app = assemble_test_app(&[]).await;
        let response = respond(
            &app,
            "/api/health",
            loopback_peer(),
            &[("host", "evil.example"), ("origin", "http://evil.example")],
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "回环请求不受 Origin/Host 校验约束"
        );
    }

    #[tokio::test]
    async fn non_loopback_cross_origin_and_domain_host_are_rejected() {
        let app = assemble_test_app(&[]).await;

        let cross_origin = respond(
            &app,
            "/api/health",
            lan_peer(),
            &[
                ("host", "192.168.1.8:9240"),
                ("origin", "http://evil.example"),
            ],
        )
        .await;
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);

        let rebinding = respond(
            &app,
            "/api/health",
            lan_peer(),
            &[
                ("host", "attacker.example:9240"),
                ("origin", "http://attacker.example:9240"),
            ],
        )
        .await;
        assert_eq!(
            rebinding.status(),
            StatusCode::FORBIDDEN,
            "域名 Host 即便与 Origin 同源也拒绝(rebinding)"
        );

        let static_via_domain =
            respond(&app, "/", lan_peer(), &[("host", "attacker.example")]).await;
        assert_eq!(
            static_via_domain.status(),
            StatusCode::FORBIDDEN,
            "静态资源同样在守卫之后"
        );
    }

    #[tokio::test]
    async fn non_loopback_same_origin_and_allowed_list_pass() {
        let app = assemble_test_app(&["http://localhost:1420"]).await;

        let same_origin = respond(
            &app,
            "/api/health",
            lan_peer(),
            &[
                ("host", "192.168.1.8:9240"),
                ("origin", "http://192.168.1.8:9240"),
            ],
        )
        .await;
        assert_eq!(
            same_origin.status(),
            StatusCode::OK,
            "自 serve 的 SPA 同源放行"
        );

        let listed_origin = respond(
            &app,
            "/api/health",
            lan_peer(),
            &[
                ("host", "192.168.1.8:9240"),
                ("origin", "http://localhost:1420"),
            ],
        )
        .await;
        assert_eq!(listed_origin.status(), StatusCode::OK, "列表内 Origin 放行");

        let listed_host = respond(&app, "/", lan_peer(), &[("host", "localhost:1420")]).await;
        assert_eq!(
            listed_host.status(),
            StatusCode::OK,
            "列表内 Origin 对应 Host 的顶层导航放行"
        );
    }

    const WS_UPGRADE_HEADERS: &[(&str, &str)] = &[
        ("connection", "Upgrade"),
        ("upgrade", "websocket"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
    ];

    fn local_daemon_token(app: &TestApp) -> String {
        crate::companion::local_daemon_token::ensure_local_daemon_token(
            app._daemon_temp.path(),
            false,
        )
        .expect("ensure local daemon token")
    }

    #[tokio::test]
    async fn local_pair_request_is_loopback_only() {
        let app = assemble_test_app(&[]).await;

        let from_lan = post_json(
            &app,
            "/api/pair/local/request",
            lan_peer(),
            &[
                ("host", "192.168.1.8:9240"),
                ("origin", "http://192.168.1.8:9240"),
            ],
            serde_json::json!({ "name": "Chrome" }),
        )
        .await;
        assert_eq!(
            from_lan.status(),
            StatusCode::FORBIDDEN,
            "非回环来源不得申请本机配对"
        );

        let from_loopback = post_json(
            &app,
            "/api/pair/local/request",
            loopback_peer(),
            &[],
            serde_json::json!({ "name": "Chrome" }),
        )
        .await;
        assert_eq!(from_loopback.status(), StatusCode::OK);
        let started: serde_json::Value =
            serde_json::from_str(&body_text(from_loopback).await).expect("json");
        assert_eq!(
            started["code"].as_str().map(str::len),
            Some(6),
            "确认码为 6 位数字"
        );
        assert!(started["requestId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
    }

    #[tokio::test]
    async fn local_pair_decision_requires_authorization_and_hands_out_token() {
        let app = assemble_test_app(&[]).await;
        let token = local_daemon_token(&app);

        let started = post_json(
            &app,
            "/api/pair/local/request",
            loopback_peer(),
            &[],
            serde_json::json!({}),
        )
        .await;
        let started: serde_json::Value =
            serde_json::from_str(&body_text(started).await).expect("json");
        let request_id = started["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();

        let unauthorized = post_json(
            &app,
            "/api/pair/local/decision",
            loopback_peer(),
            &[],
            serde_json::json!({ "requestId": request_id, "approve": true }),
        )
        .await;
        assert_eq!(
            unauthorized.status(),
            StatusCode::UNAUTHORIZED,
            "确认面必须带既有鉴权(壳/CLI 持有 Local Daemon Token)"
        );

        let approved = post_json(
            &app,
            "/api/pair/local/decision",
            loopback_peer(),
            &[("authorization", &format!("Bearer {token}"))],
            serde_json::json!({ "requestId": request_id, "approve": true }),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);
        let approved: serde_json::Value =
            serde_json::from_str(&body_text(approved).await).expect("json");
        assert_eq!(approved["status"], "approved");
        assert_eq!(
            approved["token"],
            serde_json::Value::Null,
            "确认响应不回传 token(token 只经回环轮询交给申请者)"
        );

        let status = respond(
            &app,
            &format!("/api/pair/local/request/{request_id}"),
            loopback_peer(),
            &[],
        )
        .await;
        assert_eq!(status.status(), StatusCode::OK);
        let status: serde_json::Value =
            serde_json::from_str(&body_text(status).await).expect("json");
        assert_eq!(status["status"], "approved");
        assert!(
            status["token"]
                .as_str()
                .is_some_and(|value| value.starts_with("cmx_")),
            "浏览器拿到普通 Pairing Token"
        );

        let from_lan = respond(
            &app,
            &format!("/api/pair/local/request/{request_id}"),
            lan_peer(),
            &[("host", "192.168.1.8:9240")],
        )
        .await;
        assert_eq!(
            from_lan.status(),
            StatusCode::FORBIDDEN,
            "token 轮询同样限回环"
        );
    }

    #[tokio::test]
    async fn local_pair_pending_requires_authorization_and_lists_requests() {
        let app = assemble_test_app(&[]).await;
        let token = local_daemon_token(&app);

        let started = post_json(
            &app,
            "/api/pair/local/request",
            loopback_peer(),
            &[],
            serde_json::json!({ "name": "Edge" }),
        )
        .await;
        assert_eq!(started.status(), StatusCode::OK);

        let unauthorized = respond(&app, "/api/pair/local/pending", loopback_peer(), &[]).await;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let listed = respond(
            &app,
            "/api/pair/local/pending",
            loopback_peer(),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed: serde_json::Value =
            serde_json::from_str(&body_text(listed).await).expect("json");
        assert_eq!(listed["requests"].as_array().map(Vec::len), Some(1));
        assert_eq!(listed["requests"][0]["name"], "Edge");
    }

    #[tokio::test]
    async fn local_pair_denial_is_reported_to_the_browser() {
        let app = assemble_test_app(&[]).await;
        let token = local_daemon_token(&app);

        let started = post_json(
            &app,
            "/api/pair/local/request",
            loopback_peer(),
            &[],
            serde_json::json!({}),
        )
        .await;
        let started: serde_json::Value =
            serde_json::from_str(&body_text(started).await).expect("json");
        let request_id = started["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();

        let denied = post_json(
            &app,
            "/api/pair/local/decision",
            loopback_peer(),
            &[("authorization", &format!("Bearer {token}"))],
            serde_json::json!({ "requestId": request_id, "approve": false }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::OK);

        let status = respond(
            &app,
            &format!("/api/pair/local/request/{request_id}"),
            loopback_peer(),
            &[],
        )
        .await;
        let status: serde_json::Value =
            serde_json::from_str(&body_text(status).await).expect("json");
        assert_eq!(status["status"], "denied");
        assert_eq!(status["token"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn ws_handshake_from_non_loopback_is_rejected_by_origin_guard() {
        let app = assemble_test_app(&[]).await;
        let token = crate::companion::local_daemon_token::ensure_local_daemon_token(
            app._daemon_temp.path(),
            false,
        )
        .expect("ensure local daemon token");

        let rejected = respond(
            &app,
            &format!("/api/ws?token={token}"),
            lan_peer(),
            &[
                ("host", "192.168.1.8:9240"),
                ("origin", "http://evil.example"),
            ]
            .iter()
            .copied()
            .chain(WS_UPGRADE_HEADERS.iter().copied())
            .collect::<Vec<_>>(),
        )
        .await;
        assert_eq!(
            rejected.status(),
            StatusCode::FORBIDDEN,
            "非回环 WS 握手同样经过 Origin 守卫(升级前拒绝)"
        );
    }

    /// oneshot 无法模拟真实连接升级(axum 会报 "no upgrade state"),
    /// 回环 WS 升级用真实 TCP 握手验证——同 headless 健康检查模式。
    #[tokio::test]
    async fn loopback_ws_upgrade_completes_with_valid_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let temp = tempfile::tempdir().expect("tempdir");
        let daemon = Arc::new(
            DaemonState::assemble(
                PathRoots {
                    app_data_dir: temp.path().to_path_buf(),
                    resource_dir: None,
                },
                Arc::new(crate::daemon::NullUiEventSink),
            )
            .expect("assemble"),
        );

        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);

        super::start_daemon_server(daemon.clone(), port, false, "127.0.0.1".to_string())
            .await
            .expect("start daemon server");
        let token =
            crate::companion::local_daemon_token::ensure_local_daemon_token(temp.path(), false)
                .expect("ensure local daemon token");

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let request = format!(
            "GET /api/ws?token={token} HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\
             \r\n"
        );
        stream.write_all(request.as_bytes()).await.expect("write");
        // WS 升级后连接保持打开,只读首个响应块断言握手结果。
        let mut buf = vec![0_u8; 1024];
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf))
            .await
            .expect("handshake read timeout")
            .expect("read handshake response");
        let response = String::from_utf8_lossy(&buf[..read]).to_string();
        assert!(
            response.starts_with("HTTP/1.1 101"),
            "回环 WS 握手应完成 101 升级, got: {response}"
        );
        drop(stream);

        super::stop_daemon_for_state(&daemon.companion)
            .await
            .expect("stop daemon");
    }
}
