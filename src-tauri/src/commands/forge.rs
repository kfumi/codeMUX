use keyring::Entry;
use tauri::State;

use crate::forge::{self, CreatePullRequestRequest, CreatePullRequestResult};
use crate::AppState;

const GITEE_KEYRING_SERVICE: &str = "com.codemux.desktop";
const GITEE_KEYRING_USER: &str = "gitee-personal-access-token";

fn gitee_entry() -> Result<Entry, String> {
    Entry::new(GITEE_KEYRING_SERVICE, GITEE_KEYRING_USER)
        .map_err(|error| format!("创建系统凭据项失败：{}", error))
}

fn read_gitee_token() -> Option<String> {
    gitee_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.trim().is_empty())
}

#[tauri::command]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    request: CreatePullRequestRequest,
) -> Result<CreatePullRequestResult, String> {
    let config = state.config.lock().unwrap().clone();
    forge::create_pull_request_in_project(request, &config, read_gitee_token())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_gitee_credential_status() -> bool {
    read_gitee_token().is_some()
}

#[tauri::command]
pub fn set_gitee_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Gitee Token 不能为空".to_string());
    }
    gitee_entry()?
        .set_password(token)
        .map_err(|error| format!("保存 Gitee Token 失败：{}", error))
}

#[tauri::command]
pub fn clear_gitee_token() -> Result<(), String> {
    let entry = gitee_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(error) if error.to_string().to_ascii_lowercase().contains("not found") => Ok(()),
        Err(error) => Err(format!("清除 Gitee Token 失败：{}", error)),
    }
}
