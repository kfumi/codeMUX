//! Terminal PTY routes for the Daemon control plane.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{delete, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;

use tauri::Manager;

use crate::commands::terminal::TerminalState;
use crate::companion::server::{authorize, authorize_token, ApiError, ServerContext};

pub fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/terminals", post(start_terminal))
        .route("/terminals/{terminal_id}/write", post(write_terminal))
        .route("/terminals/{terminal_id}/resize", post(resize_terminal))
        .route("/terminals/{terminal_id}", delete(close_terminal))
        .route("/ws/terminal", axum::routing::get(terminal_ws_handler))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTerminalRequest {
    project_path: String,
    cols: u16,
    rows: u16,
}

async fn start_terminal(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<StartTerminalRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let terminal_state = ctx.app.state::<TerminalState>();
    let terminal_id = crate::commands::terminal::start_terminal_for_companion(
        terminal_state.inner(),
        body.project_path,
        body.cols,
        body.rows,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "terminalId": terminal_id })))
}

#[derive(Debug, Deserialize)]
struct WriteTerminalRequest {
    data: String,
}

async fn write_terminal(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(terminal_id): Path<String>,
    Json(body): Json<WriteTerminalRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let terminal_state = ctx.app.state::<TerminalState>();
    crate::commands::terminal::write_terminal_for_companion(
        terminal_state.inner(),
        &terminal_id,
        &body.data,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeTerminalRequest {
    cols: u16,
    rows: u16,
}

async fn resize_terminal(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(terminal_id): Path<String>,
    Json(body): Json<ResizeTerminalRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let terminal_state = ctx.app.state::<TerminalState>();
    crate::commands::terminal::resize_terminal_for_companion(
        terminal_state.inner(),
        &terminal_id,
        body.cols,
        body.rows,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn close_terminal(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(terminal_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let terminal_state = ctx.app.state::<TerminalState>();
    crate::commands::terminal::close_terminal_for_companion(terminal_state.inner(), &terminal_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWsQuery {
    token: String,
    terminal_id: String,
}

pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<TerminalWsQuery>,
) -> Result<Response, ApiError> {
    authorize_token(&ctx, &query.token, Some(peer))?;
    let terminal_id = query.terminal_id.clone();
    Ok(ws.on_upgrade(move |socket| handle_terminal_socket(socket, ctx, terminal_id)))
}

async fn handle_terminal_socket(mut socket: WebSocket, ctx: ServerContext, terminal_id: String) {
    let terminal_state = ctx.app.state::<TerminalState>();
    let (mut rx, replay) = match crate::commands::terminal::subscribe_terminal_for_companion(
        terminal_state.inner(),
        &terminal_id,
    ) {
        Ok(subscription) => subscription,
        Err(error) => {
            let _ = socket
                .send(Message::Text(
                    serde_json::json!({
                        "type": "error",
                        "terminalId": terminal_id,
                        "error": error,
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            return;
        }
    };

    if let Some(replay) = replay {
        let payload = serde_json::json!({
            "type": "output",
            "terminalId": terminal_id,
            "data": replay,
        });
        if socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) {
                            if body.get("type").and_then(|v| v.as_str()) == Some("write") {
                                let data = body.get("data").and_then(|v| v.as_str()).unwrap_or("");
                                let _ = crate::commands::terminal::write_terminal_for_companion(
                                    terminal_state.inner(),
                                    &terminal_id,
                                    data,
                                );
                            } else if body.get("type").and_then(|v| v.as_str()) == Some("resize") {
                                let cols = body.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                                let rows = body.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                                let _ = crate::commands::terminal::resize_terminal_for_companion(
                                    terminal_state.inner(),
                                    &terminal_id,
                                    cols,
                                    rows,
                                );
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) if socket.send(Message::Pong(payload.clone())).await.is_err() => break,
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(payload) => {
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}
