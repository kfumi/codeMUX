use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;

use tauri::Manager;

use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::companion::CompanionState;
use crate::db::operations;
use crate::AppState;

pub fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/daemon/status", get(daemon_status))
        .route("/sessions/archived", get(list_archived_sessions))
        .route("/sessions/{session_id}/maintenance", patch(session_maintenance))
        .route("/sessions/{session_id}/archive", post(archive_session))
        .route("/sessions/{session_id}/unarchive", post(unarchive_session))
}

async fn daemon_status(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let companion_state = ctx.app.state::<CompanionState>();
    let app_state = ctx.app.state::<AppState>();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let active_sessions = operations::get_all_sessions(&db)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len();
    Ok(Json(serde_json::json!({
        "loopbackReady": companion_state.inner.is_loopback_running(),
        "lanExposed": companion_state.inner.is_lan_exposed(),
        "activeSessionCount": active_sessions,
    })))
}

async fn list_archived_sessions(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Vec<operations::Session>>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let sessions = operations::get_all_archived_sessions(&db)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(sessions))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMaintenanceRequest {
    title: Option<String>,
    pinned: Option<bool>,
    read_only: Option<bool>,
}

async fn session_maintenance(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionMaintenanceRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if let Some(title) = body.title.as_deref() {
        operations::update_session_title(&db, &session_id, title)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    if let Some(pinned) = body.pinned {
        operations::set_session_pinned(&db, &session_id, pinned)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    if let Some(read_only) = body.read_only {
        let session = operations::get_session(&db, &session_id)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::bad_request("Session not found"))?;
        if session.origin != "imported" {
            return Err(ApiError::bad_request(
                "Only imported sessions can change read-only state",
            ));
        }
        operations::set_session_read_only(&db, &session_id, read_only)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    let session = operations::get_session(&db, &session_id)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::bad_request("Session not found"))?;
    Ok(Json(session))
}

async fn archive_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::archive_session(&db, &session_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unarchive_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::unarchive_session(&db, &session_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
