use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, ACCEPT};
use serde::Deserialize;
use base64::Engine as _;

use super::types::{RepoSkillEntry, SkillSource};

#[derive(Debug, Deserialize)]
struct GitHubContent {
    name: String,
    #[serde(rename = "type")]
    content_type: String,
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
}

fn build_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("codemux/0.1"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.is_empty() {
            if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", token)) {
                headers.insert("Authorization", val);
            }
        }
    }
    headers
}

pub async fn browse_repo_skills(
    source: &SkillSource,
    installed_names: &[String],
) -> Result<Vec<RepoSkillEntry>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        source.repo, source.skills_path
    );

    let resp = client.get(&url)
        .headers(build_headers())
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {}: {}", status, body));
    }

    let contents: Vec<GitHubContent> = resp.json().await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let mut entries = Vec::new();
    for item in contents.iter().filter(|c| c.content_type == "dir") {
        let skill_md_url = format!(
            "https://api.github.com/repos/{}/contents/{}/SKILL.md",
            source.repo, item.path
        );
        let description = match client.get(&skill_md_url).headers(build_headers()).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(content) = resp.json::<GitHubContent>().await {
                    content.content.and_then(|c| {
                        let decoded = base64::engine::general_purpose::STANDARD
                            .decode(c.replace('\n', "").replace(' ', ""))
                            .ok()?;
                        let text = String::from_utf8(decoded).ok()?;
                        super::db::parse_frontmatter(&text).0
                    })
                } else {
                    None
                }
            }
            _ => None,
        };

        entries.push(RepoSkillEntry {
            name: item.name.clone(),
            description,
            path: item.path.clone(),
            installed: installed_names.contains(&item.name),
        });
    }

    Ok(entries)
}

pub async fn download_skill_files(
    repo: &str,
    skill_path: &str,
) -> Result<Vec<(String, String)>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        repo, skill_path
    );

    let resp = client.get(&url)
        .headers(build_headers())
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {}: {}", status, body));
    }

    let contents: Vec<GitHubContent> = resp.json().await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let mut files = Vec::new();
    for item in contents.iter().filter(|c| c.content_type == "file") {
        if let Some(ref content_b64) = item.content {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(content_b64.replace('\n', "").replace(' ', ""))
                .map_err(|e| format!("Base64 decode failed for {}: {}", item.name, e))?;
            let text = String::from_utf8(decoded)
                .map_err(|e| format!("UTF-8 decode failed for {}: {}", item.name, e))?;
            files.push((item.name.clone(), text));
        }
    }

    Ok(files)
}
