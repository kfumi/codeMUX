//! Model Provider HTTP routes for the Daemon control plane.

use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::net::SocketAddr;
use std::str::FromStr;

use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::model_providers::ModelProvider;

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/providers", get(list_providers).post(upsert_provider))
        .route("/providers/templates", get(list_provider_templates))
        .route(
            "/providers/templates/{template_id}/instantiate",
            post(instantiate_template),
        )
        .route(
            "/providers/{provider_id}",
            axum::routing::delete(delete_provider),
        )
        .route("/providers/{provider_id}/active", post(set_active_provider))
        .route(
            "/providers/{provider_id}/enabled",
            post(set_provider_enabled),
        )
        .route("/providers/{provider_id}/usable", get(provider_usable))
        .route("/providers/test", post(test_provider))
        .route("/providers/fetch-models", post(fetch_provider_models_route))
        .route(
            "/providers/opencode-free-models",
            get(fetch_opencode_free_models_route),
        )
}

async fn list_providers(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let config = state
        .config
        .lock()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(serde_json::json!({
        "providers": config.model_providers,
        "activeProviderId": config.active_provider_id,
    })))
}

async fn list_provider_templates(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let templates = crate::commands::model_provider::list_builtin_provider_templates();
    Ok(Json(serde_json::json!(templates)))
}

async fn instantiate_template(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(template_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let provider = crate::commands::model_provider::instantiate_builtin_provider_template_impl(
        &ctx.daemon,
        template_id,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(provider)))
}

async fn upsert_provider(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(provider): Json<ModelProvider>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::model_provider::upsert_model_provider_impl(&ctx.daemon, provider)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_provider(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::model_provider::delete_model_provider_impl(&ctx.daemon, provider_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn set_active_provider(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::model_provider::set_active_model_provider_impl(&ctx.daemon, provider_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetProviderEnabledRequest {
    enabled: bool,
}

async fn set_provider_enabled(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Json(body): Json<SetProviderEnabledRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::model_provider::set_model_provider_enabled_impl(
        &ctx.daemon,
        provider_id,
        body.enabled,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUsableQuery {
    agent_kind: String,
}

async fn provider_usable(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ProviderUsableQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let agent_kind = crate::config::types::AgentKind::from_str(&query.agent_kind)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let usable = crate::commands::model_provider::provider_usable_for_agent_impl(
        &ctx.daemon,
        provider_id,
        agent_kind,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "usable": usable })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestProviderRequest {
    api_key: String,
    base_url: String,
}

async fn test_provider(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<TestProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let _ = ctx;
    let message = crate::commands::model_provider::test_model_provider(body.api_key, body.base_url)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "message": message })))
}

async fn fetch_provider_models_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<TestProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let models =
        crate::commands::provider::fetch_provider_models_for_companion(body.api_key, body.base_url)
            .await
            .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(models)))
}

async fn fetch_opencode_free_models_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let models = crate::commands::provider::fetch_opencode_free_models_for_companion()
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(models)))
}
