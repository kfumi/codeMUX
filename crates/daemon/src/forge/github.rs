use async_trait::async_trait;

use super::{
    parse_result, run_cli, CreatePullRequestRequest, CreatePullRequestResult, ForgeAdapter,
    ForgeError, ForgePlatform, RepositoryInfo,
};

pub struct GithubAdapter;

#[async_trait]
impl ForgeAdapter for GithubAdapter {
    async fn find_open_pull_request(
        &self,
        repository: &RepositoryInfo,
        head: &str,
        base: &str,
    ) -> Result<Option<CreatePullRequestResult>, ForgeError> {
        let value = run_cli(
            "gh",
            &[
                "api".to_string(),
                "--method".to_string(),
                "GET".to_string(),
                format!("repos/{}/{}/pulls", repository.owner, repository.name),
                "--field".to_string(),
                "state=open".to_string(),
                "--field".to_string(),
                "per_page=100".to_string(),
            ],
        )?;
        let pulls: Vec<serde_json::Value> = serde_json::from_str(&value)
            .map_err(|error| ForgeError::Remote(format!("GitHub PR 列表响应无效：{}", error)))?;
        for pull in pulls {
            let source = pull
                .get("head")
                .and_then(|head| head.get("ref"))
                .and_then(serde_json::Value::as_str);
            let target = pull
                .get("base")
                .and_then(|base| base.get("ref"))
                .and_then(serde_json::Value::as_str);
            if source == Some(head) && target == Some(base) {
                return Ok(Some(parse_result(
                    &pull,
                    ForgePlatform::Github,
                    head,
                    base,
                )?));
            }
        }
        Ok(None)
    }

    async fn create_pull_request(
        &self,
        repository: &RepositoryInfo,
        request: &CreatePullRequestRequest,
        head: &str,
    ) -> Result<CreatePullRequestResult, ForgeError> {
        let value = run_cli(
            "gh",
            &[
                "api".to_string(),
                "--method".to_string(),
                "POST".to_string(),
                format!("repos/{}/{}/pulls", repository.owner, repository.name),
                "--field".to_string(),
                format!("title={}", request.title),
                "--field".to_string(),
                format!("body={}", request.body),
                "--field".to_string(),
                format!("head={}", head),
                "--field".to_string(),
                format!("base={}", request.base),
            ],
        )?;
        let value = serde_json::from_str(&value)
            .map_err(|error| ForgeError::Remote(format!("GitHub PR 响应无效：{}", error)))?;
        parse_result(&value, ForgePlatform::Github, head, &request.base)
    }
}
