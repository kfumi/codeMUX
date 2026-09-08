//! Agent runtime HTTP routes (ensure sidecar, enrichment, session metadata).

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;
use std::str::FromStr;

use tauri::Manager;

use crate::agent::attachments::enrich_attachments_for_companion;
use crate::agent::claude_history::delete_claude_session_files_for_companion;
use crate::agent::codex_history::delete_codex_session_files_for_companion;
use crate::agent::opencode_history::delete_opencode_session_for_companion;
use crate::agent::session_lifecycle::load_latest_token_usage_for_session;
use crate::agent::commands::{
    ensure_agent_session_for_companion, get_agent_session_info_for_companion, AgentState,
};
use crate::agent::session_lifecycle::{
    reset_agent_session_for_companion, shutdown_agent_for_companion,
};
use crate::agent::subagent_persist::load_session_subagents_for_companion;
use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::config::types::AgentKind;
use crate::AppState;

pub fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/sessions/{session_id}/ensure-agent", post(ensure_agent))
        .route("/sessions/{session_id}/reset-agent", post(reset_agent))
        .route("/sessions/{session_id}/shutdown-agent", post(shutdown_agent))
        .route("/agent/enrich-attachments", post(enrich_attachments))
        .route("/sessions/{session_id}/agent-info", get(agent_info))
        .route("/sessions/{session_id}/token-usage", get(token_usage))
        .route("/sessions/{session_id}/subagents", get(subagents))
        .route("/sessions/{session_id}/native-files", delete(delete_native_files))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureAgentRequest {
    cwd: String,
    reasoning_effort: Option<String>,
}

async fn ensure_agent(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<EnsureAgentRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let agent_state = ctx.app.state::<AgentState>();
    ensure_agent_session_for_companion(
        &ctx.app,
        app_state.inner(),
        agent_state.inner(),
        &session_id,
        body.cwd,
        body.reasoning_effort,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn reset_agent(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let agent_state = ctx.app.state::<AgentState>();
    reset_agent_session_for_companion(
        app_state.inner(),
        agent_state.inner(),
        &session_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn shutdown_agent(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let agent_state = ctx.app.state::<AgentState>();
    shutdown_agent_for_companion(
        app_state.inner(),
        agent_state.inner(),
        &session_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct EnrichAttachmentsRequest {
    attachments: Vec<serde_json::Value>,
}

async fn enrich_attachments(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<EnrichAttachmentsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let result = enrich_attachments_for_companion(&ctx.app, app_state.inner(), body.attachments)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInfoQuery {
    agent_kind: String,
}

async fn agent_info(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<AgentInfoQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let info = get_agent_session_info_for_companion(
        app_state.inner(),
        session_id,
        query.agent_kind,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(info)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageQuery {
    agent_kind: String,
    freshness: Option<String>,
}

async fn token_usage(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<TokenUsageQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let agent_kind = AgentKind::from_str(&query.agent_kind).map_err(ApiError::bad_request)?;
    let freshness = query.freshness.unwrap_or_else(|| "restored".to_string());
    let usage = load_latest_token_usage_for_session(
        app_state.inner(),
        &session_id,
        agent_kind,
        &freshness,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(usage)))
}

async fn subagents(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let payload =
        load_session_subagents_for_companion(&ctx.app, app_state.inner(), session_id)
            .await
            .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(payload)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteNativeFilesQuery {
    agent_kind: String,
}

async fn delete_native_files(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<DeleteNativeFilesQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.app.state::<AppState>();
    let agent_kind = AgentKind::from_str(&query.agent_kind).map_err(ApiError::bad_request)?;
    match agent_kind {
        AgentKind::ClaudeCode => {
            let deleted = delete_claude_session_files_for_companion(app_state.inner(), session_id)
                .await
                .map_err(ApiError::bad_request)?;
            Ok(Json(serde_json::json!({ "deleted": deleted })))
        }
        AgentKind::Codex => {
            let deleted = delete_codex_session_files_for_companion(app_state.inner(), session_id)
                .await
                .map_err(ApiError::bad_request)?;
            Ok(Json(serde_json::json!({ "deleted": deleted })))
        }
        AgentKind::Opencode => {
            let agent_state = ctx.app.state::<AgentState>();
            delete_opencode_session_for_companion(
                &ctx.app,
                app_state.inner(),
                agent_state.inner(),
                session_id,
            )
            .await
            .map_err(ApiError::bad_request)?;
            Ok(Json(serde_json::json!({ "deleted": [] })))
        }
        other => Err(ApiError::bad_request(format!(
            "Deleting native files is not supported for agent kind {}",
            other.as_str()
        ))),
    }
}
