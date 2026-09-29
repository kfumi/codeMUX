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
        .route("/providers/catalog/lookup", get(model_catalog_lookup_route))
        .route("/providers/catalog/names", get(model_catalog_names_route))
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
    let templates = crate::services::model_provider::list_builtin_provider_templates();
    Ok(Json(serde_json::json!(templates)))
}

async fn instantiate_template(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(template_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let provider = crate::services::model_provider::instantiate_builtin_provider_template_impl(
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
    crate::services::model_provider::upsert_model_provider_impl(&ctx.daemon, provider)
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
    crate::services::model_provider::delete_model_provider_impl(&ctx.daemon, provider_id)
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
    crate::services::model_provider::set_active_model_provider_impl(&ctx.daemon, provider_id)
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
    crate::services::model_provider::set_model_provider_enabled_impl(
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
    let usable = crate::services::model_provider::provider_usable_for_agent_impl(
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderModelsRequest {
    api_key: String,
    base_url: String,
    /// The provider's builtin template id, when it has one — scopes the
    /// models.dev modality join to that provider before falling back to the
    /// global id index (same precedence as the single-model lookup).
    #[serde(default)]
    provider: Option<String>,
}

async fn test_provider(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<TestProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let _ = ctx;
    let message = crate::services::model_provider::test_model_provider(body.api_key, body.base_url)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "message": message })))
}

async fn fetch_provider_models_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<FetchProviderModelsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let mut models =
        crate::services::provider::fetch_provider_models_for_companion(body.api_key, body.base_url)
            .await
            .map_err(ApiError::bad_request)?;
    // Join models.dev's modalities onto the rows so the picker records the
    // catalog's answer instead of guessing one. Advisory (ADR 0015): ids the
    // catalog does not list stay undeclared.
    let ids: Vec<String> = models.iter().map(|model| model.id.clone()).collect();
    let modalities = crate::services::model_catalog::input_modalities_for_ids(
        &ctx.daemon.roots,
        body.provider.as_deref(),
        &ids,
    )
    .await;
    for model in &mut models {
        model.input_modalities = modalities.get(&model.id).cloned();
    }
    Ok(Json(serde_json::json!(models)))
}

async fn fetch_opencode_free_models_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let models = crate::services::provider::fetch_opencode_free_models_for_companion()
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(models)))
}

/// Model capability lookup (models.dev). Advisory only — a miss is a normal
/// answer, not an error, because relay endpoints carry ids no catalog lists.
async fn model_catalog_lookup_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ModelCatalogQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    if query.model.trim().is_empty() {
        return Err(ApiError::bad_request("缺少 model 参数".to_string()));
    }
    let lookup = crate::services::model_catalog::lookup_model(
        &ctx.daemon.roots,
        query.provider.as_deref(),
        query.model.trim(),
    )
    .await;
    Ok(Json(serde_json::json!(lookup)))
}

/// Display names for the models a provider template can offer, keyed
/// `"<templateId>::<modelId>"`. Replaces the hand-written display-name table;
/// an id the catalog does not carry falls back to prettifying it.
async fn model_catalog_names_route(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let names =
        crate::services::model_catalog::display_names_for_templates(&ctx.daemon.roots).await;
    Ok(Json(serde_json::json!({
        "names": names.names,
        "source": names.source,
    })))
}

#[derive(serde::Deserialize)]
struct ModelCatalogQuery {
    #[serde(default)]
    provider: Option<String>,
    model: String,
}
