//! Application config HTTP routes for the Daemon control plane.

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use std::net::SocketAddr;

use tauri::Manager;

use crate::commands::provider::{
    get_config_for_companion, patch_app_config_for_companion, PatchAppConfigRequest,
};
use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::config::types::AppConfig;
use crate::AppState;

pub fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router.route("/config", get(get_config).patch(patch_config))
}

async fn get_config(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<AppConfig>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    Ok(Json(get_config_for_companion(app_state.inner())))
}

async fn patch_config(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PatchAppConfigRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    patch_app_config_for_companion(app_state.inner(), &ctx.app, body)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
