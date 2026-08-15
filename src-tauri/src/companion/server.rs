use std::net::SocketAddr;
use std::path::PathBuf;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::companion::actions::{
    respond_companion_permission, send_companion_message, send_companion_tool_response,
};
use crate::companion::config::build_mobile_bootstrap;
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
) -> Result<(), String> {
    stop_companion_server(app.clone()).await?;

    let companion_state = app.state::<CompanionState>();
    let companion_for_shutdown = companion_state.inner.clone();
    companion_state.inner.set_enabled(true);
    {
        let mut stored_port = companion_state.inner.port.write().await;
        *stored_port = port;
    }

    let static_dir = crate::companion::actions::resolve_static_dir();
    let ctx = ServerContext { app: app.clone() };
    let router = build_router(ctx, static_dir);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| format!("Failed to bind companion server on port {}: {}", port, error))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    {
        let mut guard = companion_state.inner.shutdown_tx.lock().unwrap();
        *guard = Some(shutdown_tx);
    }

    info!(target: "companion", "Companion server listening on {}", addr);

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
        companion_for_shutdown.clear_pairing_codes();
    });

    Ok(())
}

pub async fn stop_companion_server(app: AppHandle) -> Result<(), String> {
    let companion_state = app.state::<CompanionState>();
    let shutdown_tx = companion_state.inner.shutdown_tx.lock().unwrap().take();
    if let Some(tx) = shutdown_tx {
        let _ = tx.send(());
    }
    companion_state.inner.set_enabled(false);
    companion_state.clear_pairing_codes();
    Ok(())
}

fn build_router(ctx: ServerContext, static_dir: PathBuf) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/pair/claim", post(pair_claim))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{session_id}/events", get(session_events))
        .route("/sessions/{session_id}/messages", post(send_message))
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
        .layer(CorsLayer::permissive())
        .with_state(ctx)
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn pair_claim(
    State(ctx): State<ServerContext>,
    Json(body): Json<PairClaimRequest>,
) -> Result<Json<PairClaimResponse>, ApiError> {
    let companion_state = ctx.app.state::<CompanionState>();
    if !companion_state.consume_pairing_code(&body.code) {
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
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
    let after = query.after.unwrap_or(-1);
    let events = if after < 0 {
        operations::get_session_snapshot(&db, &session_id)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .unwrap_or_default()
    } else {
        operations::get_session_events_after(&db, &session_id, after)
            .map_err(|error| ApiError::internal(error.to_string()))?
    };
    Ok(Json(events))
}

async fn send_message(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SendMessageRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers)?;
    if body.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("Prompt cannot be empty"));
    }
    send_companion_message(&ctx.app, &session_id, body.prompt.trim())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::ACCEPTED)
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
    let token = extract_bearer_token(headers).ok_or_else(|| ApiError::unauthorized("Missing token"))?;
    authorize_token(ctx, &token)
}

fn authorize_token(ctx: &ServerContext, token: &str) -> Result<(), ApiError> {
    let app_state = ctx.app.state::<AppState>();
    let db = app_state.db.lock().map_err(|error| ApiError::internal(error.to_string()))?;
    operations::verify_pairing_token(&db, token)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::unauthorized("Invalid token"))?;
    Ok(())
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
