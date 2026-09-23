use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;
use std::str::FromStr;

use crate::agent::fork::{
    fork_claude_session_for_companion, fork_codex_session_for_companion,
    fork_opencode_session_for_companion, fork_pi_session_for_companion,
};
use crate::agent::history_import::resync_session_from_native_for_companion;
use crate::agent::rewind::{rewind_agent_session_for_companion, RewindTarget};
use crate::companion::server::{authorize, ApiError, ServerContext};
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::services::session::{
    delete_session_with_agent_cleanup_for_companion, update_session_permissions_for_companion,
    update_session_provider_for_companion, update_session_reasoning_effort_for_companion,
    update_session_working_path_for_companion,
};

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/daemon/status", get(daemon_status))
        .route("/sessions/archived", get(list_archived_sessions))
        .route(
            "/sessions/{session_id}/maintenance",
            patch(session_maintenance),
        )
        .route("/sessions/{session_id}/archive", post(archive_session))
        .route("/sessions/{session_id}/unarchive", post(unarchive_session))
        .route("/sessions/{session_id}/fork", post(fork_session))
        .route("/sessions/{session_id}/rewind", post(rewind_session))
        .route("/sessions/{session_id}/resync", post(resync_session))
        .route("/sessions/{session_id}", delete(delete_session))
}

async fn daemon_status(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let companion_state = ctx.daemon.companion.clone();
    let app_state = ctx.daemon.app.clone();
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
    let app_state = ctx.daemon.app.clone();
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
    /// 手动改名置 true 锁定标题（此后原生标题刷新跳过）；缺省仅写标题不锁定，
    /// 供首条消息自动播种等自动路径使用。
    title_locked: Option<bool>,
    pinned: Option<bool>,
    read_only: Option<bool>,
    working_path: Option<String>,
    touch: Option<bool>,
    provider_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    permission_config: Option<String>,
    plan_mode: Option<String>,
}

async fn session_maintenance(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionMaintenanceRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let app_state = ctx.daemon.app.clone();
    {
        let db = app_state
            .db
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if let Some(title) = body.title.as_deref() {
            if body.title_locked == Some(true) {
                operations::rename_session_title(&db, &session_id, title)
                    .map_err(|error| ApiError::bad_request(error.to_string()))?;
            } else {
                operations::update_session_title(&db, &session_id, title)
                    .map_err(|error| ApiError::bad_request(error.to_string()))?;
            }
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
        if body.touch == Some(true) {
            operations::touch_session(&db, &session_id)
                .map_err(|error| ApiError::bad_request(error.to_string()))?;
        }
    }

    if let Some(working_path) = body.working_path {
        update_session_working_path_for_companion(
            &ctx.daemon.app,
            session_id.clone(),
            working_path,
        )
        .map_err(ApiError::bad_request)?;
    }

    // 标题变更广播给所有订阅方（其他客户端/移动端原地址同步显示）。
    if body.title.is_some() {
        let final_title = {
            let db = app_state
                .db
                .lock()
                .map_err(|error| ApiError::internal(error.to_string()))?;
            operations::get_session(&db, &session_id)
                .map_err(|error| ApiError::internal(error.to_string()))?
                .map(|session| session.title)
        };
        if let Some(final_title) = final_title {
            crate::companion::events::broadcast_session_title_changed(
                &ctx.daemon.companion,
                &session_id,
                &final_title,
            );
        }
    }

    if let Some(model) = body.model {
        update_session_provider_for_companion(
            &ctx.daemon.app,
            session_id.clone(),
            body.provider_id.clone(),
            model,
            body.reasoning_effort.clone(),
        )
        .map_err(ApiError::bad_request)?;
    } else if let Some(reasoning_effort) = body.reasoning_effort.clone() {
        update_session_reasoning_effort_for_companion(
            &ctx.daemon.app,
            session_id.clone(),
            reasoning_effort,
        )
        .map_err(ApiError::bad_request)?;
    }

    if body.permission_config.is_some() || body.plan_mode.is_some() {
        update_session_permissions_for_companion(
            &ctx.daemon,
            session_id.clone(),
            body.permission_config.clone(),
            body.plan_mode.clone(),
        )
        .await
        .map_err(ApiError::bad_request)?;
    }

    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
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
    let app_state = ctx.daemon.app.clone();
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
    let app_state = ctx.daemon.app.clone();
    let db = app_state
        .db
        .lock()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    operations::unarchive_session(&db, &session_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkSessionRequest {
    agent_kind: Option<String>,
    fork_event_id: String,
    fork_provider_message_id: Option<String>,
    fork_provider_turn_id: Option<String>,
    fork_provider_turn_ordinal: Option<usize>,
    title: Option<String>,
}

async fn fork_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<ForkSessionRequest>,
) -> Result<Json<operations::Session>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let agent_kind = if let Some(kind) = body.agent_kind.as_deref() {
        kind.to_string()
    } else {
        let app_state = ctx.daemon.app.clone();
        let db = app_state
            .db
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let session = operations::get_session(&db, &session_id)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::bad_request("Session not found"))?;
        session.agent_kind.as_str().to_string()
    };

    let session = match AgentKind::from_str(&agent_kind).map_err(ApiError::bad_request)? {
        AgentKind::Codex => fork_codex_session_for_companion(
            &ctx.daemon,
            session_id,
            body.fork_event_id,
            body.fork_provider_message_id,
            body.fork_provider_turn_id,
            body.fork_provider_turn_ordinal,
            body.title,
        )
        .await
        .map_err(ApiError::bad_request)?,
        AgentKind::Opencode => fork_opencode_session_for_companion(
            &ctx.daemon,
            session_id,
            body.fork_event_id,
            body.fork_provider_message_id,
            body.title,
        )
        .await
        .map_err(ApiError::bad_request)?,
        AgentKind::Pi => fork_pi_session_for_companion(
            &ctx.daemon,
            session_id,
            body.fork_event_id,
            body.fork_provider_message_id,
            body.title,
        )
        .await
        .map_err(ApiError::bad_request)?,
        _ => fork_claude_session_for_companion(
            &ctx.daemon,
            session_id,
            body.fork_event_id,
            body.fork_provider_message_id,
            body.title,
        )
        .await
        .map_err(ApiError::bad_request)?,
    };
    Ok(Json(session))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewindSessionRequest {
    agent_kind: String,
    target: Option<RewindTarget>,
    mode: Option<String>,
}

async fn rewind_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<RewindSessionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let result = rewind_agent_session_for_companion(
        &ctx.daemon,
        session_id,
        body.agent_kind,
        body.target,
        body.mode,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn resync_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let result = resync_session_from_native_for_companion(&ctx.daemon, session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn delete_session(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    delete_session_with_agent_cleanup_for_companion(&ctx.daemon, session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod maintenance_auth_tests {
    #[test]
    fn session_maintenance_authorizes_before_touching_app_state() {
        let source = include_str!("routes_extended.rs");
        let start = source
            .find("async fn session_maintenance")
            .expect("session_maintenance handler");
        let body = &source[start..start + 600];
        let authorize = body.find("authorize(").expect("authorize call");
        let app_state = body.find("app_state").expect("app_state usage");
        assert!(authorize < app_state);
    }

    #[test]
    fn fork_session_authorizes_before_mutating_sessions() {
        let source = include_str!("routes_extended.rs");
        let start = source
            .find("async fn fork_session")
            .expect("fork_session handler");
        let body = &source[start..start + 1200];
        let authorize = body.find("authorize(").expect("authorize call");
        let fork = body
            .find("fork_codex_session_for_companion")
            .or_else(|| body.find("fork_claude_session_for_companion"))
            .expect("fork handler body");
        assert!(authorize < fork);
    }
}
