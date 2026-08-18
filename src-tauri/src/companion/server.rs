use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::companion::actions::{
    interrupt_companion_session, respond_companion_permission, send_companion_message,
    send_companion_tool_response, update_companion_settings, CompanionSettingsUpdate,
};
use crate::companion::config::build_mobile_bootstrap;
use crate::companion::context::build_composer_context;
use crate::companion::desktop_id::get_or_create_desktop_id;
use crate::companion::offer::build_pairing_offer;
use crate::companion::pairing::complete_pairing;
use crate::companion::state::{CompanionBroadcastEvent, CompanionState};
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;

#[derive(Clone)]
struct ServerContext {
    app: AppHandle,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    prompt: String,
    input_payload: Option<serde_json::Value>,
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
struct WsQuery {
    token: String,
    session_id: String,
}

pub async fn start_companion_server(
    app: AppHandle,
    port: u16,
    listen_address: String,
) -> Result<(), String> {
    let companion_state = app.state::<CompanionState>();
    let _lifecycle_guard = companion_state.inner.lifecycle_lock.lock().await;

    stop_companion_server_inner(&companion_state).await?;

    {
        let mut stored_port = companion_state.inner.port.write().await;
        *stored_port = port;
    }

    let static_dir = crate::companion::actions::resolve_static_dir();
    let ctx = ServerContext { app: app.clone() };
    let router = build_router(ctx, static_dir);

    let addr = parse_listen_addr(&listen_address, port)?;
    let listener = bind_listener_with_retry(addr).await?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (stopped_tx, stopped_rx) = oneshot::channel::<()>();
    {
        let mut guard = companion_state.inner.shutdown_tx.lock().unwrap();
        *guard = Some(shutdown_tx);
        let mut waiter = companion_state.inner.stopped_waiter.lock().unwrap();
        *waiter = Some(stopped_rx);
    }

    companion_state.inner.set_enabled(true);
    info!(target: "companion", "Companion server listening on {}", addr);

    if let Err(error) = crate::companion::relay::sync_relay_transport(&app, &companion_state).await {
        warn!(target: "companion", "Failed to start relay transport: {}", error);
    }

    let companion_for_shutdown = companion_state.inner.clone();
    tokio::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(error) = result {
            warn!(target: "companion", "Companion server stopped with error: {}", error);
        }
        companion_for_shutdown.set_enabled(false);
        let _ = stopped_tx.send(());
    });

    Ok(())
}

pub async fn stop_companion_server(app: AppHandle) -> Result<(), String> {
    let companion_state = app.state::<CompanionState>();
    let _lifecycle_guard = companion_state.inner.lifecycle_lock.lock().await;
    stop_companion_server_inner(&companion_state).await
}

async fn stop_companion_server_inner(companion_state: &CompanionState) -> Result<(), String> {
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
    companion_state.inner.set_enabled(false);
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
    socket
        .listen(1024)
        .map_err(|error| error.to_string())?;
    socket
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let std_listener: std::net::TcpListener = socket.into();
    tokio::net::TcpListener::from_std(std_listener).map_err(|error| error.to_string())
}

fn build_router(ctx: ServerContext, static_dir: PathBuf) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/pair/offer", get(pair_offer))
        .route("/pair/claim", post(pair_claim))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{session_id}/events", get(session_events))
        .route("/sessions/{session_id}/messages", post(send_message))
        .route("/sessions/{session_id}/composer-context", get(composer_context))
        .route("/sessions/{session_id}/settings", patch(update_session_settings))
        .route("/sessions/{session_id}/interrupt", post(interrupt_session))
        .route("/projects", get(list_projects))
        .route("/bootstrap", get(bootstrap))
        .route("/permissions/respond", post(permission_respond))
        .route("/interactive/user-input", post(user_input_respond))
        .route("/ws", get(ws_handler));

    let index_file = static_dir.join("index.html");
    let static_service = ServeDir::new(static_dir).not_found_service(ServeFile::new(index_file));

    Router::new()
        .nest("/api", api)
        .fallback_service(static_service)
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(CorsLayer::permissive())
        .with_state(ctx)
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn pair_offer(State(ctx): State<ServerContext>) -> Result<Json<crate::companion::offer::CompanionPairingOffer>, ApiError> {
    let companion_state = ctx.app.state::<CompanionState>();
    let (desktop_id, port, relay) = {
        let app_state = ctx.app.state::<AppState>();
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
            crate::config::save_config(&ctx.app, &config)
                .map_err(|error| ApiError::internal(error))?;
        }
        (desktop_id, port, relay)
    };

    let lan_ip = local_ip_address::local_ip()
        .ok()
        .map(|ip| ip.to_string());
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
        .map_err(|error| ApiError::bad_request(error))
}

async fn pair_claim(
    State(ctx): State<ServerContext>,
    Json(body): Json<PairClaimRequest>,
) -> Result<Json<PairClaimResponse>, ApiError> {
    let companion_state = ctx.app.state::<CompanionState>();
    // 配对码随二维码下发，扫码即自动 claim：校验但不作废，
    // 二维码本身 5 分钟过期，窗口内允许多次尝试（PWA 刷新/重试）。
    if !companion_state.validate_pairing_code(&body.code) {
        return Err(ApiError::bad_request("Invalid or expired pairing code"));
    }

    let app_state = ctx.app.state::<AppState>();
    let result = complete_pairing(app_state.inner(), body.name.as_deref())
        .map_err(|error| ApiError::internal(error))?;
    Ok(Json(PairClaimResponse {
        token: result.token,
        device_id: result.device_id,
    }))
}

async fn list_sessions(State(ctx): State<ServerContext>, headers: HeaderMap) -> Result<Json<Vec<operations::Session>>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
    let sessions = operations::get_all_sessions(&db).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(sessions))
}

async fn create_session(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    let agent_kind = AgentKind::from_str(body.agent_kind.as_deref().unwrap_or("claude_code"))
        .map_err(|error| ApiError::bad_request(error))?;
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
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
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<SessionEventsQuery>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    let after = query.after.unwrap_or(-1);
    if after < 0 {
        let events = crate::agent::history_import::load_session_events(app_state, session_id)
            .await
            .map_err(ApiError::internal)?;
        return Ok(Json(events));
    }
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let events = operations::get_session_events_after(&db, &session_id, after)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(events))
}

async fn send_message(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SendMessageRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers)?;
    if !has_sendable_input(&body.prompt, body.input_payload.as_ref()) {
        return Err(ApiError::bad_request("Prompt cannot be empty"));
    }
    send_companion_message(
        &ctx.app,
        &session_id,
        body.prompt.trim(),
        body.input_payload,
    )
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::ACCEPTED)
}

async fn composer_context(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<crate::companion::context::ComposerContext>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    build_composer_context(app_state.inner(), &session_id)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

async fn update_session_settings(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionSettingsRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers)?;
    let agent_kind = AgentKind::from_str(&body.agent_kind)
        .map_err(ApiError::bad_request)?;
    let session = update_companion_settings(
        &ctx.app,
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
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers)?;
    interrupt_companion_session(&ctx.app, &session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_projects(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
) -> Result<Json<Vec<operations::Project>>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
    let projects = operations::get_all_projects(&db).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(projects))
}

async fn bootstrap(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
) -> Result<Json<crate::companion::config::MobileBootstrap>, ApiError> {
    authorize(&ctx, &headers)?;
    let app_state = ctx.app.state::<AppState>();
    Ok(Json(build_mobile_bootstrap(app_state.inner())))
}

async fn permission_respond(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(body): Json<PermissionRespondRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers)?;
    respond_companion_permission(&ctx.app, &body.session_id, &body.request_id, body.response)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn user_input_respond(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(body): Json<UserInputRespondRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers)?;
    send_companion_tool_response(&ctx.app, &body.session_id, &body.tool_use_id, body.response)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(ctx): State<ServerContext>,
    Query(query): Query<WsQuery>,
) -> Result<Response, ApiError> {
    authorize_token(&ctx, &query.token)?;
    let session_id = query.session_id.clone();
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, ctx, session_id)))
}

async fn handle_socket(mut socket: WebSocket, ctx: ServerContext, session_id: String) {
    let companion_state = ctx.app.state::<CompanionState>();
    let mut rx = companion_state.inner.event_tx.subscribe();

    let initial_events = if let Some(app_state) = ctx.app.try_state::<AppState>() {
        let events = app_state
            .db
            .lock()
            .ok()
            .and_then(|db| operations::get_session_snapshot(&db, &session_id).ok().flatten())
            .unwrap_or_default();
        events
    } else {
        Vec::new()
    };

    for event in initial_events {
        let payload = serde_json::json!({ "type": "event", "sessionId": session_id, "event": event });
        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
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
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

fn authorize(ctx: &ServerContext, headers: &HeaderMap) -> Result<(), ApiError> {
    authorize_device(ctx, headers).map(|_| ())
}

fn authorize_device(ctx: &ServerContext, headers: &HeaderMap) -> Result<operations::PairedDevice, ApiError> {
    let token = extract_bearer_token(headers).ok_or_else(|| ApiError::unauthorized("Missing token"))?;
    authorize_token_device(ctx, &token)
}

fn authorize_token(ctx: &ServerContext, token: &str) -> Result<(), ApiError> {
    authorize_token_device(ctx, token).map(|_| ())
}

fn authorize_token_device(ctx: &ServerContext, token: &str) -> Result<operations::PairedDevice, ApiError> {
    let app_state = ctx.app.state::<AppState>();
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
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
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
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
        return trimmed.parse::<SocketAddr>().map_err(|error| error.to_string());
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
                .and_then(|payload| payload["attachments"][0]["name"].as_str().map(str::to_string)),
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
}
