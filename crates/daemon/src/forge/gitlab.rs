use async_trait::async_trait;

use super::{
    parse_result, run_cli, CreatePullRequestRequest, CreatePullRequestResult, ForgeAdapter,
    ForgeError, ForgePlatform, RepositoryInfo,
};

pub struct GitlabAdapter;

fn project_path(repository: &RepositoryInfo) -> String {
    format!("{}%2F{}", repository.owner, repository.name)
}

#[async_trait]
impl ForgeAdapter for GitlabAdapter {
    async fn find_open_pull_request(
        &self,
        repository: &RepositoryInfo,
        head: &str,
        base: &str,
    ) -> Result<Option<CreatePullRequestResult>, ForgeError> {
        let value = run_cli(
            "glab",
            &[
                "api".to_string(),
                "--method".to_string(),
                "GET".to_string(),
                format!(
                    "projects/{}/merge_requests?state=opened&source_branch={}&target_branch={}",
                    project_path(repository),
                    head,
                    base
                ),
            ],
        )?;
        let requests: Vec<serde_json::Value> = serde_json::from_str(&value)
            .map_err(|error| ForgeError::Remote(format!("GitLab MR 列表响应无效：{}", error)))?;
        requests
            .first()
            .map(|request| parse_result(request, ForgePlatform::Gitlab, head, base))
            .transpose()
    }

    async fn create_pull_request(
        &self,
        repository: &RepositoryInfo,
        request: &CreatePullRequestRequest,
        head: &str,
    ) -> Result<CreatePullRequestResult, ForgeError> {
        let value = run_cli(
            "glab",
            &[
                "api".to_string(),
                "--method".to_string(),
                "POST".to_string(),
                format!("projects/{}/merge_requests", project_path(repository)),
                "--field".to_string(),
                format!("title={}", request.title),
                "--field".to_string(),
                format!("description={}", request.body),
                "--field".to_string(),
                format!("source_branch={}", head),
                "--field".to_string(),
                format!("target_branch={}", request.base),
            ],
        )?;
        let value = serde_json::from_str(&value)
            .map_err(|error| ForgeError::Remote(format!("GitLab MR 响应无效：{}", error)))?;
        parse_result(&value, ForgePlatform::Gitlab, head, &request.base)
    }
}
