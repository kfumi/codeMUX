//! History import HTTP routes for the Daemon control plane.

use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;

use tauri::Manager;

use crate::agent::history_import::{
    discover_importable_sessions_for_companion, import_sessions_for_companion, ImportCandidate,
    ImportSessionsRequest, ImportSessionsResult,
};
use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::AppState;

pub fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/sessions/import/candidates", get(discover_candidates))
        .route("/sessions/import", post(import_sessions))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverCandidatesQuery {
    agent_kind: Option<String>,
}

async fn discover_candidates(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<DiscoverCandidatesQuery>,
) -> Result<Json<Vec<ImportCandidate>>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let candidates = discover_importable_sessions_for_companion(
        app_state.inner(),
        query.agent_kind,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(candidates))
}

async fn import_sessions(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ImportSessionsRequest>,
) -> Result<Json<ImportSessionsResult>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app = ctx.app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let app_state = app.state::<AppState>();
        import_sessions_for_companion(app_state.inner(), body)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}
