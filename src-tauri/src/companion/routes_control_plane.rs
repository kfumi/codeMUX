//! Control-plane HTTP routes (MCP, skills, scheduled tasks, workspace, git, runtime).

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;

use crate::commands::scheduled_tasks::ScheduledTaskInput;
use crate::companion::server::{authorize, ApiError, ServerContext};

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        // MCP
        .route("/mcp", get(list_mcp).post(upsert_mcp))
        .route("/mcp/import", post(import_mcp))
        .route("/mcp/probe-all", post(probe_all_mcp))
        .route("/mcp/{id}", delete(delete_mcp))
        .route("/mcp/{id}/probe", post(probe_mcp))
        .route("/mcp/{id}/apps", patch(toggle_mcp_app))
        // Skills
        .route("/skills", get(list_skills))
        .route("/skills/importable", get(list_importable_skills))
        .route("/skills/sync", post(sync_skills))
        .route("/skills/import", post(import_skills))
        .route("/skills/register", post(register_skill))
        .route("/skills/project", get(list_project_skills))
        .route("/skills/{id}", delete(uninstall_skill))
        .route("/skills/{id}/content", get(get_skill_content))
        .route("/skills/{id}/apps", patch(toggle_skill_app))
        // Scheduled tasks
        .route(
            "/scheduled-tasks",
            get(list_scheduled_tasks).post(create_scheduled_task),
        )
        .route("/scheduled-tasks/timezone", get(get_scheduled_timezone))
        .route(
            "/scheduled-tasks/{task_id}",
            get(get_scheduled_task)
                .patch(update_scheduled_task)
                .delete(delete_scheduled_task),
        )
        .route(
            "/scheduled-tasks/{task_id}/enabled",
            patch(set_scheduled_enabled),
        )
        .route("/scheduled-tasks/{task_id}/runs", get(list_scheduled_runs))
        .route("/scheduled-tasks/{task_id}/run", post(run_scheduled_now))
        .route(
            "/scheduled-tasks/runs/{run_id}",
            delete(delete_scheduled_run),
        )
        // Workspace files
        .route("/workspace/files/read", post(read_workspace_file))
        .route("/workspace/files/write", post(write_workspace_file))
        .route("/workspace/files/delete", post(delete_workspace_file))
        .route("/workspace/files/list", post(list_workspace_directory))
        // Git
        .route("/workspace/git/changed-files", post(git_changed_files))
        .route(
            "/workspace/git/changed-files-since-head",
            post(git_changed_files_since_head),
        )
        .route(
            "/workspace/git/repository-state",
            post(git_repository_state),
        )
        .route("/workspace/git/status-changes", post(git_status_changes))
        .route(
            "/workspace/git/status-change-detail",
            post(git_status_change_detail),
        )
        .route("/workspace/git/stage", post(git_stage))
        .route("/workspace/git/unstage", post(git_unstage))
        .route("/workspace/git/revert", post(git_revert))
        .route("/workspace/git/create-branch", post(git_create_branch))
        .route("/workspace/git/checkout-branch", post(git_checkout_branch))
        .route(
            "/workspace/git/worktrees",
            get(git_list_worktrees).post(git_create_worktree),
        )
        .route("/workspace/git/commit", post(git_commit))
        .route("/workspace/git/push", post(git_push))
        .route(
            "/workspace/git/generate-commit-message",
            post(git_generate_commit_message),
        )
        .route(
            "/workspace/git/generate-pr-description",
            post(git_generate_pr_description),
        )
        .route("/workspace/git/pull-request", post(git_create_pull_request))
        .route("/workspace/git/gitee/credentials", get(gitee_credentials))
        .route(
            "/workspace/git/gitee/token",
            post(set_gitee_token).delete(clear_gitee_token),
        )
        // Runtime
        .route("/runtime/managed", get(check_managed_runtimes))
        .route(
            "/runtime/managed/{provider}/versions",
            get(list_managed_runtime_versions),
        )
        .route(
            "/runtime/managed/{provider}/refresh",
            post(refresh_managed_runtime),
        )
        .route("/runtime/managed/install", post(install_managed_runtime))
        .route("/runtime/managed/upgrade", post(upgrade_managed_runtime))
        .route("/runtime/managed/repair", post(repair_managed_runtime))
        .route(
            "/runtime/managed/{provider}",
            delete(remove_managed_runtime),
        )
        // Usage statistics
        .route("/usage/stats", get(get_usage_stats))
        .route("/usage/token-breakdown", get(get_usage_token_breakdown))
}

// --- MCP ---------------------------------------------------------------------

async fn list_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let servers =
        crate::commands::mcp::get_mcp_servers_impl(&state).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(servers)))
}

async fn upsert_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(server): Json<crate::mcp::types::McpServer>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::mcp::upsert_mcp_server_impl(&state, server).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::mcp::delete_mcp_server_impl(&state, id).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleMcpAppRequest {
    app: String,
    enabled: bool,
}

async fn toggle_mcp_app(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ToggleMcpAppRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::mcp::toggle_mcp_app_impl(&state, id, body.app, body.enabled)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn probe_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::mcp::probe_mcp_server_impl(&state, id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn probe_all_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let results = crate::commands::mcp::probe_all_mcp_servers_impl(&state)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::to_value(results).unwrap_or_default()))
}

async fn import_mcp(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result =
        crate::commands::mcp::import_mcp_from_apps_impl(&state).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

// --- Skills ------------------------------------------------------------------

async fn list_skills(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let skills = crate::skills::commands::list_installed_skills_impl(&state)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(skills)))
}

async fn list_importable_skills(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let skills = crate::skills::commands::list_importable_skills_impl(&state)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(skills)))
}

async fn uninstall_skill(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let removed =
        crate::skills::commands::uninstall_skill_impl(&state, id).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "removed": removed })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleSkillAppRequest {
    app: String,
    enabled: bool,
}

async fn toggle_skill_app(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ToggleSkillAppRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::skills::commands::toggle_skill_app_impl(&state, id, body.app, body.enabled)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn get_skill_content(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let content = crate::skills::commands::get_skill_content_impl(&state, id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "content": content })))
}

async fn sync_skills(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let skills =
        crate::skills::commands::scan_disk_skills_impl(&state).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(skills)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterSkillRequest {
    name: String,
}

async fn register_skill(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterSkillRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let skill = crate::skills::commands::register_skill_from_disk_impl(&state, body.name)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(skill)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSkillsRequest {
    selected: Option<Vec<String>>,
}

async fn import_skills(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ImportSkillsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::skills::commands::import_skills_from_apps_impl(&state, body.selected)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProjectSkillsQuery {
    project_root: String,
    agent_kind: String,
    force: Option<bool>,
}

async fn list_project_skills(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ListProjectSkillsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let skills = crate::skills::commands::list_project_skills(
        query.project_root,
        query.agent_kind,
        Some(query.force.unwrap_or(false)),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(skills)))
}

// --- Scheduled tasks ---------------------------------------------------------

async fn list_scheduled_tasks(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let tasks = crate::commands::scheduled_tasks::list_scheduled_tasks_impl(&state)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(tasks)))
}

async fn get_scheduled_task(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let task = crate::commands::scheduled_tasks::get_scheduled_task_impl(&state, task_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(task)))
}

async fn create_scheduled_task(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<ScheduledTaskInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let task = crate::commands::scheduled_tasks::create_scheduled_task_impl(&state, input)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(task)))
}

async fn update_scheduled_task(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<ScheduledTaskInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let task = crate::commands::scheduled_tasks::update_scheduled_task_impl(&state, task_id, input)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(task)))
}

async fn delete_scheduled_task(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::scheduled_tasks::delete_scheduled_task_impl(&state, task_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetScheduledEnabledRequest {
    enabled: bool,
}

async fn set_scheduled_enabled(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(body): Json<SetScheduledEnabledRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let task = crate::commands::scheduled_tasks::set_scheduled_task_enabled_impl(
        &state,
        task_id,
        body.enabled,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(task)))
}

async fn list_scheduled_runs(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let runs = crate::commands::scheduled_tasks::list_scheduled_task_runs_impl(&state, task_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(runs)))
}

async fn run_scheduled_now(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let run = crate::scheduled_tasks::run_task_now(&ctx.daemon, &task_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(run)))
}

async fn delete_scheduled_run(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::scheduled_tasks::delete_scheduled_task_run_impl(&state, run_id)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn get_scheduled_timezone(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let timezone = crate::commands::scheduled_tasks::get_scheduled_task_timezone();
    Ok(Json(serde_json::json!({ "timezone": timezone })))
}

// --- Workspace files ---------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileRequest {
    path: String,
    base_path: Option<String>,
}

async fn read_workspace_file(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ReadFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let content = crate::commands::file::read_file(body.path, body.base_path)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "content": content })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileRequest {
    path: String,
    content: String,
    base_path: Option<String>,
}

async fn write_workspace_file(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::file::write_file(body.path, body.content, body.base_path)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFileRequest {
    path: String,
    base_path: Option<String>,
}

async fn delete_workspace_file(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<DeleteFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::file::delete_file(body.path, body.base_path).map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirectoryRequest {
    path: String,
    depth: Option<u32>,
    base_path: Option<String>,
    include_hidden: Option<bool>,
}

async fn list_workspace_directory(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ListDirectoryRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let nodes = crate::commands::file::list_directory(
        body.path,
        body.base_path,
        body.depth,
        Some(body.include_hidden.unwrap_or(false)),
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(nodes)))
}

// --- Git ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitProjectRequest {
    project_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedFilesRequest {
    project_path: String,
    baseline_tree: String,
}

async fn git_changed_files(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitChangedFilesRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let files = crate::commands::git::get_git_changed_files(body.project_path, body.baseline_tree)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(files)))
}

async fn git_changed_files_since_head(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitProjectRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let files = crate::commands::git::get_git_changed_files_since_head(body.project_path)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(files)))
}

async fn git_repository_state(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitProjectRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let repo = crate::commands::git::get_git_repository_state(body.project_path)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(repo)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusChangesRequest {
    project_path: String,
    area: String,
}

async fn git_status_changes(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitStatusChangesRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let area = parse_git_status_area(&body.area)?;
    let changes = crate::commands::git::get_git_status_changes(body.project_path, area)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(changes)))
}

fn parse_git_status_area(area: &str) -> Result<crate::commands::git::GitStatusArea, ApiError> {
    match area.to_ascii_lowercase().as_str() {
        "unstaged" => Ok(crate::commands::git::GitStatusArea::Unstaged),
        "staged" => Ok(crate::commands::git::GitStatusArea::Staged),
        _ => Err(ApiError::bad_request(format!(
            "Unsupported git status area: {}",
            area
        ))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusChangeDetailRequest {
    project_path: String,
    area: String,
    file_path: String,
}

async fn git_status_change_detail(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitStatusChangeDetailRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let area = parse_git_status_area(&body.area)?;
    let change =
        crate::commands::git::get_git_status_change_detail(body.project_path, area, body.file_path)
            .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(change)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageRequest {
    project_path: String,
    file_path: Option<String>,
}

async fn git_stage(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitStageRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::git::stage_git_status_changes(body.project_path, body.file_path)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn git_unstage(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitStageRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::git::unstage_git_status_changes(body.project_path, body.file_path)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitRevertRequest {
    project_path: String,
    area: String,
    file_path: Option<String>,
}

async fn git_revert(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitRevertRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let area = parse_git_status_area(&body.area)?;
    crate::commands::git::revert_git_status_changes(body.project_path, area, body.file_path)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCreateBranchRequest {
    project_path: String,
    branch_name: String,
    checkout: bool,
}

async fn git_create_branch(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitCreateBranchRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::git::create_git_branch(body.project_path, body.branch_name, body.checkout)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCheckoutBranchRequest {
    project_path: String,
    branch_name: String,
}

async fn git_checkout_branch(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitCheckoutBranchRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::git::checkout_git_branch(body.project_path, body.branch_name)
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn git_list_worktrees(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(body): Query<GitProjectRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let worktrees = crate::commands::git::list_git_worktrees(body.project_path)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(worktrees)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCreateWorktreeRequest {
    project_path: String,
    branch_name: String,
    base_branch: Option<String>,
}

async fn git_create_worktree(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitCreateWorktreeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let worktree = crate::commands::git::create_git_worktree(
        body.project_path,
        body.branch_name,
        body.base_branch,
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(worktree)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRequest {
    project_path: String,
    message: String,
}

async fn git_commit(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitCommitRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let commit = crate::commands::git::commit_git_changes(body.project_path, body.message)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "commit": commit })))
}

async fn git_push(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitProjectRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::git::push_git_branch(body.project_path).map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn git_generate_commit_message(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitProjectRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let config = state.config.lock().unwrap().clone();
    let suggestion = crate::commands::git::generate_git_commit_message_in_project(
        std::path::Path::new(&body.project_path),
        &config,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(suggestion)))
}

async fn git_generate_pr_description(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<GitProjectRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let config = state.config.lock().unwrap().clone();
    let suggestion = crate::commands::git::generate_pull_request_description_in_project(
        std::path::Path::new(&body.project_path),
        &config,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(suggestion)))
}

async fn git_create_pull_request(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<crate::forge::CreatePullRequestRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::forge::create_pull_request_impl(&state, request)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn gitee_credentials(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    Ok(Json(serde_json::json!({
        "configured": crate::commands::forge::get_gitee_credential_status(),
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetGiteeTokenRequest {
    token: String,
}

async fn set_gitee_token(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SetGiteeTokenRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::forge::set_gitee_token(body.token).map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn clear_gitee_token(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    crate::commands::forge::clear_gitee_token().map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// --- Runtime -----------------------------------------------------------------

async fn check_managed_runtimes(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::runtime::check_managed_runtimes_impl(&state)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn list_managed_runtime_versions(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let versions = crate::commands::runtime::list_managed_runtime_versions_impl(&state, provider)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(versions)))
}

async fn refresh_managed_runtime(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::runtime::refresh_managed_runtime_impl(&state, provider)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedRuntimeProviderRequest {
    provider: String,
    version: Option<String>,
}

async fn install_managed_runtime(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ManagedRuntimeProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let provider = crate::runtime::types::Provider::from_str(&body.provider)
        .ok_or_else(|| ApiError::bad_request(format!("未知的 Provider: {}", body.provider)))?;
    let result = crate::commands::runtime::install_managed_runtime_impl(
        &state,
        body.provider,
        body.version,
        std::sync::Arc::new(crate::commands::runtime::RuntimeProgressReporter::new(
            ctx.daemon.ui_events.clone(),
            provider,
        )),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn upgrade_managed_runtime(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ManagedRuntimeProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let provider = crate::runtime::types::Provider::from_str(&body.provider)
        .ok_or_else(|| ApiError::bad_request(format!("未知的 Provider: {}", body.provider)))?;
    let result = crate::commands::runtime::upgrade_managed_runtime_impl(
        &state,
        body.provider,
        std::sync::Arc::new(crate::commands::runtime::RuntimeProgressReporter::new(
            ctx.daemon.ui_events.clone(),
            provider,
        )),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn repair_managed_runtime(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ManagedRuntimeProviderRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let provider = crate::runtime::types::Provider::from_str(&body.provider)
        .ok_or_else(|| ApiError::bad_request(format!("未知的 Provider: {}", body.provider)))?;
    let result = crate::commands::runtime::repair_managed_runtime_impl(
        &state,
        body.provider,
        std::sync::Arc::new(crate::commands::runtime::RuntimeProgressReporter::new(
            ctx.daemon.ui_events.clone(),
            provider,
        )),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn remove_managed_runtime(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    crate::commands::runtime::remove_managed_runtime_impl(&state, provider)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageQuery {
    agent_kind: Option<String>,
    days: Option<u32>,
}

async fn get_usage_stats(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::usage::get_usage_stats_impl(&state, query.agent_kind, query.days)
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}

async fn get_usage_token_breakdown(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let state = ctx.daemon.app.clone();
    let result = crate::commands::usage::get_usage_token_breakdown_impl(
        &state,
        query.agent_kind,
        query.days,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!(result)))
}
