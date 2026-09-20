use async_trait::async_trait;
use reqwest::Client;

use super::{
    parse_result, request_json, CreatePullRequestRequest, CreatePullRequestResult, ForgeAdapter,
    ForgeError, ForgePlatform, RepositoryInfo,
};

pub struct GiteeAdapter {
    token: String,
    client: Client,
}

impl GiteeAdapter {
    pub fn new(token: String) -> Self {
        Self {
            token,
            client: Client::new(),
        }
    }

    fn endpoint(&self, repository: &RepositoryInfo) -> String {
        format!(
            "https://gitee.com/api/v5/repos/{}/{}/pulls",
            repository.owner, repository.name
        )
    }
}

#[async_trait]
impl ForgeAdapter for GiteeAdapter {
    async fn find_open_pull_request(
        &self,
        repository: &RepositoryInfo,
        head: &str,
        base: &str,
    ) -> Result<Option<CreatePullRequestResult>, ForgeError> {
        let value = request_json(
            self.client
                .get(self.endpoint(repository))
                .query(&[("access_token", self.token.as_str()), ("state", "open")]),
        )
        .await?;
        let requests = value
            .as_array()
            .ok_or_else(|| ForgeError::Remote("Gitee PR 列表响应无效".to_string()))?;
        for request in requests {
            let source = request
                .get("head")
                .and_then(|head| head.get("ref"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| request.get("head").and_then(serde_json::Value::as_str));
            let target = request
                .get("base")
                .and_then(|base| base.get("ref"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| request.get("base").and_then(serde_json::Value::as_str));
            if source == Some(head) && target == Some(base) {
                return Ok(Some(parse_result(
                    request,
                    ForgePlatform::Gitee,
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
        let value = request_json(
            self.client
                .post(self.endpoint(repository))
                .query(&[("access_token", self.token.as_str())])
                .json(&serde_json::json!({
                    "title": request.title,
                    "body": request.body,
                    "head": head,
                    "base": request.base,
                })),
        )
        .await?;
        parse_result(&value, ForgePlatform::Gitee, head, &request.base)
    }
}
