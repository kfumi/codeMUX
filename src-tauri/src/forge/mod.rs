use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use crate::commands::git;
use crate::config::types::AppConfig;

mod gitee;
mod github;
mod gitlab;

pub use gitee::GiteeAdapter;
pub use github::GithubAdapter;
pub use gitlab::GitlabAdapter;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForgePlatform {
    Github,
    Gitlab,
    Gitee,
}

#[derive(Debug, Clone)]
pub struct RepositoryInfo {
    pub platform: ForgePlatform,
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestRequest {
    pub project_path: String,
    pub title: String,
    pub body: String,
    pub base: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestResult {
    pub platform: ForgePlatform,
    pub url: String,
    pub number: u64,
    pub head: String,
    pub base: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeError {
    InvalidRepository(String),
    InvalidRequest(String),
    Authentication(String),
    Command(String),
    Network(String),
    Remote(String),
    Unsupported(String),
}

impl std::fmt::Display for ForgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRepository(message)
            | Self::InvalidRequest(message)
            | Self::Authentication(message)
            | Self::Command(message)
            | Self::Network(message)
            | Self::Remote(message)
            | Self::Unsupported(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ForgeError {}

#[async_trait]
pub trait ForgeAdapter: Send + Sync {
    async fn find_open_pull_request(
        &self,
        repository: &RepositoryInfo,
        head: &str,
        base: &str,
    ) -> Result<Option<CreatePullRequestResult>, ForgeError>;

    async fn create_pull_request(
        &self,
        repository: &RepositoryInfo,
        request: &CreatePullRequestRequest,
        head: &str,
    ) -> Result<CreatePullRequestResult, ForgeError>;
}

pub fn parse_repository(
    _remote_name: String,
    remote_url: String,
) -> Result<RepositoryInfo, ForgeError> {
    let (host, path) = split_remote_url(&remote_url)?;
    let segments: Vec<&str> = path
        .trim_matches('/')
        .trim_end_matches(".git")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let name = segments.last().ok_or_else(|| {
        ForgeError::InvalidRepository("无法从 Git remote 解析仓库名称".to_string())
    })?;

    let platform = if host.eq_ignore_ascii_case("github.com") {
        ForgePlatform::Github
    } else if host.eq_ignore_ascii_case("gitlab.com")
        || host.to_ascii_lowercase().contains("gitlab")
    {
        ForgePlatform::Gitlab
    } else if host.eq_ignore_ascii_case("gitee.com") {
        ForgePlatform::Gitee
    } else {
        return Err(ForgeError::Unsupported(format!(
            "暂不支持 Forge 平台：{}",
            host
        )));
    };
    let owner = if platform == ForgePlatform::Gitlab && segments.len() > 1 {
        segments[..segments.len() - 1].join("/")
    } else {
        segments
            .first()
            .ok_or_else(|| {
                ForgeError::InvalidRepository("无法从 Git remote 解析仓库所有者".to_string())
            })?
            .to_string()
    };

    Ok(RepositoryInfo {
        platform,
        owner,
        name: (*name).to_string(),
    })
}

fn split_remote_url(remote_url: &str) -> Result<(String, String), ForgeError> {
    let remote = remote_url.trim();
    if let Some(rest) = remote.strip_prefix("git@") {
        let (host, path) = rest
            .split_once(':')
            .ok_or_else(|| ForgeError::InvalidRepository("Git remote 地址格式无效".to_string()))?;
        return Ok((host.to_string(), path.to_string()));
    }

    let parsed = reqwest::Url::parse(remote).map_err(|error| {
        ForgeError::InvalidRepository(format!("Git remote 地址格式无效：{}", error))
    })?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ForgeError::InvalidRepository("Git remote 缺少主机名".to_string()))?;
    Ok((host.to_string(), parsed.path().to_string()))
}

pub async fn create_pull_request_in_project(
    request: CreatePullRequestRequest,
    _config: &AppConfig,
    gitee_token: Option<String>,
) -> Result<CreatePullRequestResult, ForgeError> {
    if request.project_path.trim().is_empty() {
        return Err(ForgeError::InvalidRequest("项目目录不能为空".to_string()));
    }
    let project_path_string = request.project_path.clone();
    let project_path = Path::new(&project_path_string);

    git::ensure_pr_worktree_clean(project_path).map_err(ForgeError::InvalidRequest)?;
    let head = git::current_branch_in_project(project_path).map_err(ForgeError::InvalidRequest)?;
    let base = if request.base.trim().is_empty() {
        git::pr_base_branch_in_project(project_path).map_err(ForgeError::InvalidRequest)?
    } else {
        request.base.trim().to_string()
    };
    if base == head {
        return Err(ForgeError::InvalidRequest(
            "当前分支即基准分支，没有可创建 PR 的提交差异".to_string(),
        ));
    }
    if !git::has_commits_since_base(project_path, &base).map_err(ForgeError::InvalidRequest)? {
        return Err(ForgeError::InvalidRequest(
            "当前分支相对基准分支没有新提交".to_string(),
        ));
    }

    let (remote_name, remote_url) =
        git::repository_remote_in_project(project_path).map_err(ForgeError::InvalidRepository)?;
    let repository = parse_repository(remote_name, remote_url)?;
    let mut request = request;
    if request.title.trim().is_empty() {
        request.title = git::recent_commit_title_in_project(project_path)
            .map_err(ForgeError::InvalidRequest)?;
    }
    if request.body.trim().is_empty() {
        request.body = git::recent_commits_body_in_project(project_path, &base)
            .map_err(ForgeError::InvalidRequest)?;
    }
    if request.title.trim().is_empty() || request.body.trim().is_empty() {
        return Err(ForgeError::InvalidRequest(
            "PR 标题和正文不能同时为空".to_string(),
        ));
    }

    let adapter: Box<dyn ForgeAdapter> = match repository.platform {
        ForgePlatform::Github => Box::new(GithubAdapter),
        ForgePlatform::Gitlab => Box::new(GitlabAdapter),
        ForgePlatform::Gitee => Box::new(GiteeAdapter::new(gitee_token.ok_or_else(|| {
            ForgeError::Authentication("请先配置 Gitee Personal Access Token".to_string())
        })?)),
    };

    if let Some(existing) = adapter
        .find_open_pull_request(&repository, &head, &base)
        .await?
    {
        return Ok(existing);
    }

    git::push_git_branch_in_project(project_path)
        .map_err(|error| ForgeError::Command(format!("推送分支失败：{}", error)))?;
    adapter
        .create_pull_request(&repository, &request, &head)
        .await
}

fn run_cli(program: &str, args: &[String]) -> Result<String, ForgeError> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| ForgeError::Command(format!("无法运行 {}：{}", program, error)))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if message.to_ascii_lowercase().contains("auth")
            || message.to_ascii_lowercase().contains("login")
            || message.contains("401")
            || message.contains("403")
        {
            return Err(ForgeError::Authentication(if message.is_empty() {
                format!("{} 未登录", program)
            } else {
                message
            }));
        }
        return Err(ForgeError::Command(if message.is_empty() {
            format!("{} 执行失败", program)
        } else {
            message
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn request_json(request: reqwest::RequestBuilder) -> Result<serde_json::Value, ForgeError> {
    let response = request
        .send()
        .await
        .map_err(|error| ForgeError::Network(error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| ForgeError::Network(error.to_string()))?;
    let json =
        serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({ "message": body }));
    if !status.is_success() {
        let message = json
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("远程 Forge 请求失败");
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(ForgeError::Authentication(message.to_string()));
        }
        return Err(ForgeError::Remote(format!("{}：{}", status, message)));
    }
    Ok(json)
}

fn parse_result(
    value: &serde_json::Value,
    platform: ForgePlatform,
    head: &str,
    base: &str,
) -> Result<CreatePullRequestResult, ForgeError> {
    let url = value
        .get("html_url")
        .or_else(|| value.get("web_url"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ForgeError::Remote("Forge 响应缺少 PR URL".to_string()))?;
    let number = value
        .get("number")
        .or_else(|| value.get("iid"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| ForgeError::Remote("Forge 响应缺少 PR 编号".to_string()))?;
    Ok(CreatePullRequestResult {
        platform,
        url: url.to_string(),
        number,
        head: head.to_string(),
        base: base.to_string(),
    })
}

#[cfg(test)]
pub(crate) fn parse_result_for_test(
    value: &serde_json::Value,
    platform: ForgePlatform,
    head: &str,
    base: &str,
) -> Result<CreatePullRequestResult, ForgeError> {
    parse_result(value, platform, head, base)
}

#[cfg(test)]
mod tests {
    use super::{parse_repository, parse_result_for_test, ForgePlatform};

    #[test]
    fn parses_https_and_ssh_remotes() {
        let https = parse_repository(
            "origin".to_string(),
            "https://github.com/acme/codemux.git".to_string(),
        )
        .unwrap();
        assert_eq!(https.platform, ForgePlatform::Github);
        assert_eq!(https.owner, "acme");
        assert_eq!(https.name, "codemux");

        let ssh = parse_repository(
            "origin".to_string(),
            "git@gitee.com:acme/codemux.git".to_string(),
        )
        .unwrap();
        assert_eq!(ssh.platform, ForgePlatform::Gitee);
        assert_eq!(ssh.owner, "acme");
    }

    #[test]
    fn preserves_nested_gitlab_namespace() {
        let repository = parse_repository(
            "origin".to_string(),
            "https://gitlab.example.com/platform/team/codemux.git".to_string(),
        )
        .unwrap();
        assert_eq!(repository.platform, ForgePlatform::Gitlab);
        assert_eq!(repository.owner, "platform/team");
        assert_eq!(repository.name, "codemux");
    }

    #[test]
    fn parses_common_pull_request_response_shapes() {
        let github = parse_result_for_test(
            &serde_json::json!({ "html_url": "https://github.com/acme/codemux/pull/3", "number": 3 }),
            ForgePlatform::Github,
            "feature/pr",
            "main",
        )
        .unwrap();
        assert_eq!(github.number, 3);

        let gitlab = parse_result_for_test(
            &serde_json::json!({ "web_url": "https://gitlab.example.com/acme/codemux/-/merge_requests/4", "iid": 4 }),
            ForgePlatform::Gitlab,
            "feature/pr",
            "main",
        )
        .unwrap();
        assert_eq!(
            gitlab.url,
            "https://gitlab.example.com/acme/codemux/-/merge_requests/4"
        );
    }
}
