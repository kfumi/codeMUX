use crate::config::types::{AppConfig, Provider};
use crate::AppState;
use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

/// Empty tree hash — the tree object git uses for a repo with zero commits.
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf899d69f3612f4bf";
const COMMIT_MESSAGE_DIFF_LIMIT: usize = 12_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub original_content: Option<String>,
    pub current_content: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStatusArea {
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusChange {
    pub path: String,
    pub status: String,
    pub original_content: Option<String>,
    pub current_content: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub current_branch: Option<String>,
    pub branches: Vec<GitBranch>,
    pub detached: bool,
    pub has_uncommitted_changes: bool,
    pub ahead_count: usize,
    pub has_unpushed_commits: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessageSuggestion {
    pub message: String,
}

fn run_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    run_git_with_env(root, args, None)
}

fn run_git_with_env(
    root: &Path,
    args: &[&str],
    index_file: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = command
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git {} failed: {}", args.join(" "), stderr.trim()))
    }
}

fn is_inside_git_repo(root: &Path) -> bool {
    run_git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

fn temp_index_path() -> PathBuf {
    std::env::temp_dir().join(format!("codemux-git-index-{}", uuid::Uuid::new_v4()))
}

fn parse_nul_paths(output: &[u8]) -> Vec<String> {
    output
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .filter_map(|part| String::from_utf8(part.to_vec()).ok())
        .collect()
}

fn relative_path_to_absolute(root: &Path, relative_path: &str) -> String {
    path_to_display_string(&root.join(relative_path))
}

fn normalize_display_path(path: &str) -> String {
    let mut text = path.replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = text.strip_prefix("//?/UNC/") {
            text = format!("//{}", rest);
        } else if let Some(rest) = text.strip_prefix("//?/") {
            text = rest.to_string();
        }
    }
    text.trim_end_matches('/').to_string()
}

fn path_to_repo_relative(root: &Path, file_path: &str) -> String {
    let root_text = normalize_display_path(&path_to_display_string(root));
    let file_text = normalize_display_path(file_path);
    file_text
        .strip_prefix(&(root_text + "/"))
        .unwrap_or(&file_text)
        .to_string()
}

fn path_to_display_string(path: &Path) -> String {
    let mut text = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            text = format!(r"\\{}", rest);
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            text = rest.to_string();
        }
    }
    text.replace('\\', "/")
}

fn read_tree_file(root: &Path, tree: &str, relative_path: &str) -> Result<Option<String>, String> {
    match run_git(root, &["show", &format!("{}:{}", tree, relative_path)]) {
        Ok(bytes) => Ok(decode_text_bytes(&bytes)),
        Err(_) => Ok(None),
    }
}

fn read_index_file(root: &Path, relative_path: &str) -> Result<Option<String>, String> {
    match run_git(root, &["show", &format!(":{}", relative_path)]) {
        Ok(bytes) => Ok(decode_text_bytes(&bytes)),
        Err(_) => Ok(None),
    }
}

fn decode_text_bytes(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }

    if let Ok(content) = std::str::from_utf8(bytes) {
        return Some(normalize_line_endings(
            content.trim_start_matches('\u{feff}'),
        ));
    }

    let (content, _, had_errors) = GBK.decode(bytes);
    if had_errors {
        None
    } else {
        Some(normalize_line_endings(&content))
    }
}

/// Normalize CRLF to LF for consistent comparison
fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn count_lines(content: &str) -> usize {
    content.split('\n').filter(|line| !line.is_empty()).count()
}

fn count_file_lines(path: &Path) -> usize {
    std::fs::read(path)
        .ok()
        .and_then(|content| decode_text_bytes(&content))
        .map(|content| count_lines(&content))
        .unwrap_or(0)
}

fn git_head_tree(root: &Path) -> Result<Option<String>, String> {
    match run_git(root, &["rev-parse", "--verify", "HEAD^{tree}"]) {
        Ok(output) => Ok(Some(String::from_utf8_lossy(&output).trim().to_string())),
        Err(_) => Ok(None),
    }
}

/// Ensures the empty tree object exists in the object database and returns its hash.
/// In repos with no commits, the well-known empty tree hash may not exist as a loose
/// object, causing `git diff --cached <hash>` to fail. `git mktree` with empty input
/// creates the object.
fn ensure_empty_tree_object(root: &Path) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).arg("mktree");
    command.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Ok(EMPTY_TREE_HASH.to_string())
    }
}

fn has_uncommitted_changes(root: &Path) -> Result<bool, String> {
    let output = run_git(root, &["status", "--porcelain=v1"])?;
    Ok(!output.is_empty())
}

fn read_ahead_count(root: &Path, current_branch: Option<&str>) -> Result<usize, String> {
    if current_branch.is_none() {
        return Ok(0);
    }
    if run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_err()
    {
        return Ok(0);
    }
    let output = run_git(root, &["rev-list", "--count", "@{u}..HEAD"])?;
    Ok(String::from_utf8_lossy(&output)
        .trim()
        .parse::<usize>()
        .unwrap_or(0))
}

fn validate_branch_name(root: &Path, branch_name: &str) -> Result<String, String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    run_git(root, &["check-ref-format", "--branch", trimmed])?;
    Ok(trimmed.to_string())
}

fn status_from_name_status(status_char: &str) -> Option<&'static str> {
    match status_char {
        "A" => Some("added"),
        "D" => Some("deleted"),
        "M" => Some("modified"),
        _ => None,
    }
}

fn read_worktree_file(root: &Path, relative_path: &str) -> Option<String> {
    let absolute_path = root.join(relative_path);
    if !absolute_path.is_file() {
        return None;
    }

    std::fs::read(&absolute_path)
        .ok()
        .and_then(|content| decode_text_bytes(&content))
}

fn git_numstat_map(
    root: &Path,
    area: GitStatusArea,
    head_tree: Option<&str>,
) -> Result<HashMap<String, (usize, usize)>, String> {
    let args: Vec<&str> = match area {
        GitStatusArea::Unstaged => vec!["diff", "--numstat", "--no-renames"],
        GitStatusArea::Staged => {
            let mut base = vec!["diff", "--cached", "--numstat", "--no-renames"];
            if let Some(tree) = head_tree {
                base.push(tree);
            }
            base
        }
    };
    let output = run_git(root, &args)?;
    let text = String::from_utf8_lossy(&output);
    let mut stats = HashMap::new();

    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().unwrap_or("0");
        let deletions = parts.next().unwrap_or("0");
        let Some(relative_path) = parts.next() else {
            continue;
        };
        let additions = additions.parse::<usize>().unwrap_or(0);
        let deletions = deletions.parse::<usize>().unwrap_or(0);
        stats.insert(relative_path.to_string(), (additions, deletions));
    }

    Ok(stats)
}

pub fn read_git_status_changes(
    project_path: &Path,
    area: GitStatusArea,
) -> Result<Vec<GitStatusChange>, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    let head_tree = git_head_tree(&root)?;
    let args: Vec<&str> = match area {
        GitStatusArea::Unstaged => vec!["diff", "--name-status", "--no-renames"],
        GitStatusArea::Staged => {
            let mut base = vec!["diff", "--cached", "--name-status", "--no-renames"];
            if let Some(tree) = &head_tree {
                base.push(tree.as_str());
            }
            base
        }
    };
    let diff_output = run_git(&root, &args)?;
    let diff_text = String::from_utf8_lossy(&diff_output);
    let numstat = git_numstat_map(&root, area, head_tree.as_deref())?;
    let mut changes = Vec::new();

    for line in diff_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let Some(status) = status_from_name_status(parts[0]) else {
            continue;
        };
        let relative_path = parts[parts.len() - 1];
        let (additions, deletions) = numstat.get(relative_path).copied().unwrap_or((0, 0));
        changes.push(GitStatusChange {
            path: relative_path_to_absolute(&root, relative_path),
            status: status.to_string(),
            original_content: None,
            current_content: String::new(),
            additions,
            deletions,
        });
    }

    if matches!(area, GitStatusArea::Unstaged) {
        let untracked_output = run_git(&root, &["ls-files", "-o", "--exclude-standard", "-z"])?;
        for relative_path in parse_nul_paths(&untracked_output) {
            let absolute_path = root.join(&relative_path);
            if !absolute_path.is_file() {
                continue;
            }
            let additions = count_file_lines(&absolute_path);
            changes.push(GitStatusChange {
                path: relative_path_to_absolute(&root, &relative_path),
                status: "added".to_string(),
                original_content: None,
                current_content: String::new(),
                additions,
                deletions: 0,
            });
        }
    }

    Ok(changes)
}

pub fn read_git_status_change_detail(
    project_path: &Path,
    area: GitStatusArea,
    file_path: &str,
) -> Result<GitStatusChange, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    let relative_path = path_to_repo_relative(&root, file_path);
    let summary = read_git_status_changes(&root, area)?
        .into_iter()
        .find(|change| path_to_repo_relative(&root, &change.path) == relative_path)
        .ok_or_else(|| format!("No git change found for {}", file_path))?;

    let head_tree = git_head_tree(&root)?;
    let original = match area {
        GitStatusArea::Staged => {
            if summary.status != "added" {
                match &head_tree {
                    Some(tree) => read_tree_file(&root, tree, &relative_path)?,
                    None => None,
                }
            } else {
                None
            }
        }
        GitStatusArea::Unstaged => {
            if summary.status != "added" {
                read_index_file(&root, &relative_path)?
            } else {
                None
            }
        }
    };
    let current = match area {
        GitStatusArea::Staged => {
            if summary.status != "deleted" {
                read_index_file(&root, &relative_path)?.unwrap_or_default()
            } else {
                String::new()
            }
        }
        GitStatusArea::Unstaged => {
            if summary.status != "deleted" {
                read_worktree_file(&root, &relative_path).unwrap_or_default()
            } else {
                String::new()
            }
        }
    };

    Ok(GitStatusChange {
        original_content: original,
        current_content: current,
        ..summary
    })
}

pub fn stage_git_status_changes_for_paths(
    project_path: &Path,
    file_path: Option<&str>,
) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    match file_path {
        Some(file_path) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(&root, &["add", "-A", "--", &relative_path]).map(|_| ())
        }
        None => run_git(&root, &["add", "-A", "--", "."]).map(|_| ()),
    }
}

pub fn unstage_git_status_changes_for_paths(
    project_path: &Path,
    file_path: Option<&str>,
) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    let head_tree = git_head_tree(&root)?;
    match (head_tree.as_deref(), file_path) {
        (Some(tree), Some(file_path)) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(&root, &["reset", "-q", tree, "--", &relative_path]).map(|_| ())
        }
        (Some(tree), None) => run_git(&root, &["reset", "-q", tree, "--", "."]).map(|_| ()),
        (None, Some(file_path)) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(&root, &["rm", "--cached", "-q", "--", &relative_path]).map(|_| ())
        }
        (None, None) => run_git(&root, &["read-tree", "--empty"]).map(|_| ()),
    }
}

pub fn read_git_repository_state(project_path: &Path) -> Result<GitRepositoryState, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    let current_output = run_git(&root, &["branch", "--show-current"])?;
    let current_branch_text = String::from_utf8_lossy(&current_output).trim().to_string();
    let current_branch = if current_branch_text.is_empty() {
        None
    } else {
        Some(current_branch_text)
    };

    let branch_output = run_git(&root, &["branch", "--format=%(refname:short)"])?;
    let branch_text = String::from_utf8_lossy(&branch_output);
    let branches = branch_text
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| GitBranch {
            name: name.to_string(),
            current: current_branch.as_deref() == Some(name),
        })
        .collect();

    let detached =
        current_branch.is_none() && run_git(&root, &["rev-parse", "--short", "HEAD"]).is_ok();

    let ahead_count = read_ahead_count(&root, current_branch.as_deref())?;

    Ok(GitRepositoryState {
        current_branch,
        branches,
        detached,
        has_uncommitted_changes: has_uncommitted_changes(&root)?,
        ahead_count,
        has_unpushed_commits: ahead_count > 0,
    })
}

pub fn create_git_branch_in_project(
    project_path: &Path,
    branch_name: &str,
    checkout: bool,
) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }
    let branch_name = validate_branch_name(&root, branch_name)?;
    run_git(&root, &["branch", &branch_name])?;
    if checkout {
        run_git(&root, &["checkout", &branch_name])?;
    }
    Ok(())
}

pub fn checkout_git_branch_in_project(
    project_path: &Path,
    branch_name: &str,
) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }
    let branch_name = validate_branch_name(&root, branch_name)?;
    if has_uncommitted_changes(&root)? {
        return Err("请先提交或还原当前修改，再切换分支".to_string());
    }
    run_git(&root, &["checkout", &branch_name]).map(|_| ())
}

fn is_untracked_file(root: &Path, relative_path: &str) -> Result<bool, String> {
    let output = run_git(
        root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            relative_path,
        ],
    )?;
    Ok(!String::from_utf8_lossy(&output).trim().is_empty())
}

fn remove_untracked_path(root: &Path, relative_path: &str) -> Result<(), String> {
    let target = root.join(relative_path);
    if target.is_file() {
        std::fs::remove_file(&target)
            .map_err(|e| format!("Failed to delete {}: {}", relative_path, e))?;
    } else if target.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to delete {}: {}", relative_path, e))?;
    }
    Ok(())
}

pub fn revert_git_status_changes_in_project(
    project_path: &Path,
    area: GitStatusArea,
    file_path: Option<&str>,
) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    match (area, file_path) {
        (GitStatusArea::Unstaged, Some(file_path)) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            if is_untracked_file(&root, &relative_path)? {
                remove_untracked_path(&root, &relative_path)
            } else {
                run_git(&root, &["restore", "--worktree", "--", &relative_path]).map(|_| ())
            }
        }
        (GitStatusArea::Unstaged, None) => {
            run_git(&root, &["restore", "--worktree", "--", "."]).map(|_| ())
        }
        (GitStatusArea::Staged, Some(file_path)) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(
                &root,
                &["restore", "--staged", "--worktree", "--", &relative_path],
            )
            .map(|_| ())
        }
        (GitStatusArea::Staged, None) => {
            run_git(&root, &["restore", "--staged", "--worktree", "--", "."]).map(|_| ())
        }
    }
}

pub fn commit_git_changes_in_project(project_path: &Path, message: &str) -> Result<String, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    if run_git(&root, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err("没有已暂存修改可提交".to_string());
    }
    run_git(&root, &["commit", "-m", message])?;
    let output = run_git(&root, &["rev-parse", "--short", "HEAD"])?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

pub fn push_git_branch_in_project(project_path: &Path) -> Result<(), String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }

    let current_output = run_git(&root, &["branch", "--show-current"])?;
    let current_branch = String::from_utf8_lossy(&current_output).trim().to_string();
    if current_branch.is_empty() {
        return Err("当前处于 detached HEAD，无法推送分支".to_string());
    }

    if run_git(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok()
    {
        run_git(&root, &["push"])?;
    } else {
        run_git(&root, &["push", "-u", "origin", &current_branch])?;
    }

    Ok(())
}

pub fn build_commit_message_prompt(stat: &str, diff: &str, truncated: bool) -> String {
    format!(
        "请根据以下 staged diff 生成一条 Git 提交信息。只输出提交信息本身，不输出解释、代码块或引号。提交信息必须使用中文描述，并遵循 Conventional Commits 格式。\n\n格式要求：\n<type>(可选 scope): <中文标题，标题不超过 72 个字符>\n\n- <中文要点 1>\n- <中文要点 2>\n\n要求：\n1. 第一行必须是 Conventional Commits 标题，例如：feat: 增加分支切换入口、fix: 修复提交信息生成失败、docs: 更新使用说明。\n2. 标题后必须空一行，再输出 1 到 4 条中文要点，每条以 \"- \" 开头。\n3. 不要输出快捷键、解释说明、Markdown 代码围栏或多余前后缀。{}\n\n统计:\n{}\n\nDiff:\n{}",
        if truncated {
            "Diff 内容已截断，请基于可见内容概括。"
        } else {
            ""
        },
        stat.trim(),
        diff.trim()
    )
}

#[allow(dead_code)]
fn suggest_commit_message_from_prompt(prompt: &str) -> String {
    let lower = prompt.to_lowercase();
    if lower.contains(".md") || lower.contains("docs/") {
        "docs: 更新项目文档".to_string()
    } else if lower.contains(".test.") || lower.contains("test(") {
        "test: 更新测试覆盖".to_string()
    } else if lower.contains("fix") || lower.contains("error") {
        "fix: 修复实现问题".to_string()
    } else {
        "feat: 更新项目功能".to_string()
    }
}

pub fn build_commit_message_prompt_in_project(project_path: &Path) -> Result<String, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Err("当前项目不是 Git 仓库".to_string());
    }
    if run_git(&root, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err("没有已暂存修改可生成提交信息".to_string());
    }

    let stat =
        String::from_utf8_lossy(&run_git(&root, &["diff", "--cached", "--stat"])?).to_string();
    let raw_diff = String::from_utf8_lossy(&run_git(
        &root,
        &["diff", "--cached", "--unified=3", "--no-ext-diff"],
    )?)
    .to_string();
    let truncated = raw_diff.len() > COMMIT_MESSAGE_DIFF_LIMIT;
    let diff = if truncated {
        raw_diff
            .chars()
            .take(COMMIT_MESSAGE_DIFF_LIMIT)
            .collect::<String>()
    } else {
        raw_diff
    };
    Ok(build_commit_message_prompt(&stat, &diff, truncated))
}

fn select_commit_message_provider(config: &AppConfig) -> Result<Provider, String> {
    let provider = config
        .active_provider_id
        .as_deref()
        .and_then(|id| config.providers.iter().find(|provider| provider.id == id))
        .or_else(|| config.providers.first())
        .cloned()
        .ok_or_else(|| "请先配置 AI 供应商".to_string())?;

    if provider.api_key.trim().is_empty() {
        return Err("请先配置 AI 供应商 API Key".to_string());
    }
    if provider.default_model.trim().is_empty() {
        return Err("请先配置 AI 供应商默认模型".to_string());
    }
    if provider.anthropic_base_url.trim().is_empty() && provider.openai_base_url.trim().is_empty() {
        return Err("请先配置 AI 供应商 Base URL".to_string());
    }

    Ok(provider)
}

fn clean_commit_message(raw: &str) -> Result<String, String> {
    let text = if raw.trim().starts_with("```") {
        raw.trim()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .trim_end_matches("```")
            .trim()
            .to_string()
    } else {
        raw.trim().to_string()
    };

    let mut lines = text.lines().map(|line| line.trim_end()).collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }

    let conventional_prefixes = [
        "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore",
        "revert",
    ];
    let start = lines
        .iter()
        .position(|line| {
            let trimmed = line
                .trim()
                .trim_start_matches("- ")
                .trim_matches(|ch| matches!(ch, '"' | '\'' | '`'));
            conventional_prefixes.iter().any(|prefix| {
                trimmed.starts_with(&format!("{}: ", prefix))
                    || (trimmed.starts_with(&format!("{}(", prefix)) && trimmed.contains("): "))
                    || (trimmed.starts_with(&format!("{}!", prefix)) && trimmed.contains(": "))
            })
        })
        .unwrap_or(0);

    let mut cleaned = lines
        .into_iter()
        .skip(start)
        .map(|line| {
            line.trim_matches(|ch| matches!(ch, '"' | '\'' | '`'))
                .trim_end()
        })
        .collect::<Vec<_>>();
    if let Some(first) = cleaned.first_mut() {
        *first = first.trim_start_matches("- ").trim();
    }
    while cleaned.first().is_some_and(|line| line.trim().is_empty()) {
        cleaned.remove(0);
    }
    while cleaned.last().is_some_and(|line| line.trim().is_empty()) {
        cleaned.pop();
    }

    let message = cleaned.join("\n").trim().to_string();
    if message.is_empty() {
        Err("AI 未返回可用的提交信息".to_string())
    } else {
        Ok(message)
    }
}

fn parse_anthropic_commit_message_response(body: &serde_json::Value) -> Result<String, String> {
    let text = body
        .get("content")
        .and_then(|content| content.as_array())
        .and_then(|content| {
            content
                .iter()
                .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
                .find(|text| !text.trim().is_empty())
        })
        .ok_or_else(|| "AI 响应缺少提交信息".to_string())?;

    clean_commit_message(text)
}

fn parse_openai_commit_message_response(body: &serde_json::Value) -> Result<String, String> {
    let text = body
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .ok_or_else(|| "AI 响应缺少提交信息".to_string())?;

    clean_commit_message(text)
}

fn http_status_error(status: reqwest::StatusCode, body: &str) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        "认证失败，请检查 API Key".to_string()
    } else if body.trim().is_empty() {
        format!("AI 请求失败: HTTP {}", status.as_u16())
    } else {
        format!("AI 请求失败: HTTP {} {}", status.as_u16(), body.trim())
    }
}

async fn generate_with_anthropic(
    client: &reqwest::Client,
    provider: &Provider,
    prompt: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/v1/messages",
        provider.anthropic_base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": provider.default_model,
        "max_tokens": 220,
        "messages": [{"role": "user", "content": prompt}]
    });

    let resp = client
        .post(url)
        .header("x-api-key", provider.api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "AI 请求超时".to_string()
            } else {
                format!("AI 连接失败: {}", e)
            }
        })?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("AI 响应读取失败: {}", e))?;
    if !status.is_success() {
        return Err(http_status_error(status, &body_text));
    }

    let body: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|_| "AI 响应不是有效 JSON".to_string())?;
    parse_anthropic_commit_message_response(&body)
}

async fn generate_with_openai(
    client: &reqwest::Client,
    provider: &Provider,
    prompt: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/v1/chat/completions",
        provider.openai_base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": provider.default_model,
        "max_tokens": 220,
        "messages": [{"role": "user", "content": prompt}]
    });

    let resp = client
        .post(url)
        .header(
            "Authorization",
            format!("Bearer {}", provider.api_key.trim()),
        )
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "AI 请求超时".to_string()
            } else {
                format!("AI 连接失败: {}", e)
            }
        })?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("AI 响应读取失败: {}", e))?;
    if !status.is_success() {
        return Err(http_status_error(status, &body_text));
    }

    let body: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|_| "AI 响应不是有效 JSON".to_string())?;
    parse_openai_commit_message_response(&body)
}

async fn request_commit_message(provider: &Provider, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    if !provider.anthropic_base_url.trim().is_empty() {
        match generate_with_anthropic(&client, provider, prompt).await {
            Ok(message) => return Ok(message),
            Err(err) => {
                if err.contains("认证失败") || provider.openai_base_url.trim().is_empty() {
                    return Err(err);
                }
            }
        }
    }

    if !provider.openai_base_url.trim().is_empty() {
        return generate_with_openai(&client, provider, prompt).await;
    }

    Err("请先配置 AI 供应商 Base URL".to_string())
}

pub async fn generate_git_commit_message_in_project(
    project_path: &Path,
    config: &AppConfig,
) -> Result<GitCommitMessageSuggestion, String> {
    let prompt = build_commit_message_prompt_in_project(project_path)?;
    let provider = select_commit_message_provider(config)?;
    let message = request_commit_message(&provider, &prompt).await?;

    Ok(GitCommitMessageSuggestion { message })
}

pub fn read_git_changed_files_for_tree(
    project_path: &Path,
    baseline_tree: &str,
) -> Result<Vec<GitChangedFile>, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !is_inside_git_repo(&root) {
        return Ok(Vec::new());
    }

    let index_file = temp_index_path();
    if let Err(err) = run_git_with_env(&root, &["read-tree", baseline_tree], Some(&index_file)) {
        let _ = std::fs::remove_file(&index_file);
        return Err(err);
    }
    let add_result = run_git_with_env(&root, &["add", "-A", "--", "."], Some(&index_file));
    if let Err(err) = add_result {
        let _ = std::fs::remove_file(&index_file);
        return Err(err);
    }
    let diff_output = match run_git_with_env(
        &root,
        &[
            "diff",
            "--cached",
            "--name-status",
            "--no-renames",
            baseline_tree,
        ],
        Some(&index_file),
    ) {
        Ok(output) => output,
        Err(err) => {
            let _ = std::fs::remove_file(&index_file);
            return Err(err);
        }
    };
    let diff_text = String::from_utf8_lossy(&diff_output);

    let mut changed_files = Vec::new();

    // Parse git diff --name-status output
    for line in diff_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status_char = parts[0];
        let relative_path = parts[parts.len() - 1];

        let status = match status_char {
            "A" => "added",
            "D" => "deleted",
            "M" => "modified",
            _ => continue,
        };

        let original = if status != "added" {
            read_tree_file(&root, baseline_tree, relative_path)?
        } else {
            None
        };

        let absolute_path = root.join(relative_path);
        let current = if status != "deleted" && absolute_path.is_file() {
            std::fs::read(&absolute_path)
                .ok()
                .and_then(|content| decode_text_bytes(&content))
        } else {
            None
        };

        changed_files.push(GitChangedFile {
            path: relative_path_to_absolute(&root, relative_path),
            status: status.to_string(),
            original_content: original,
            current_content: current.unwrap_or_default(),
        });
    }

    let _ = std::fs::remove_file(&index_file);

    Ok(changed_files)
}

#[tauri::command]
pub fn get_git_changed_files(
    project_path: String,
    baseline_tree: String,
) -> Result<Vec<GitChangedFile>, String> {
    read_git_changed_files_for_tree(Path::new(&project_path), &baseline_tree)
}

#[tauri::command]
pub fn get_git_changed_files_since_head(
    project_path: String,
) -> Result<Vec<GitChangedFile>, String> {
    let root = Path::new(&project_path)
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;

    if !is_inside_git_repo(&root) {
        return Ok(Vec::new());
    }

    // Get the HEAD tree hash; for repos with no commits, ensure the empty tree
    // object exists so that `git diff --cached <tree>` succeeds.
    let head_tree = match git_head_tree(&root)? {
        Some(tree) => tree,
        None => ensure_empty_tree_object(&root)?,
    };

    read_git_changed_files_for_tree(&root, &head_tree)
}

#[tauri::command]
pub fn get_git_status_changes(
    project_path: String,
    area: GitStatusArea,
) -> Result<Vec<GitStatusChange>, String> {
    read_git_status_changes(Path::new(&project_path), area)
}

#[tauri::command]
pub fn get_git_status_change_detail(
    project_path: String,
    area: GitStatusArea,
    file_path: String,
) -> Result<GitStatusChange, String> {
    read_git_status_change_detail(Path::new(&project_path), area, &file_path)
}

#[tauri::command]
pub fn stage_git_status_changes(
    project_path: String,
    file_path: Option<String>,
) -> Result<(), String> {
    stage_git_status_changes_for_paths(Path::new(&project_path), file_path.as_deref())
}

#[tauri::command]
pub fn unstage_git_status_changes(
    project_path: String,
    file_path: Option<String>,
) -> Result<(), String> {
    unstage_git_status_changes_for_paths(Path::new(&project_path), file_path.as_deref())
}

#[tauri::command]
pub fn get_git_repository_state(project_path: String) -> Result<GitRepositoryState, String> {
    read_git_repository_state(Path::new(&project_path))
}

#[tauri::command]
pub fn create_git_branch(
    project_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<(), String> {
    create_git_branch_in_project(Path::new(&project_path), &branch_name, checkout)
}

#[tauri::command]
pub fn checkout_git_branch(project_path: String, branch_name: String) -> Result<(), String> {
    checkout_git_branch_in_project(Path::new(&project_path), &branch_name)
}

#[tauri::command]
pub fn revert_git_status_changes(
    project_path: String,
    area: GitStatusArea,
    file_path: Option<String>,
) -> Result<(), String> {
    revert_git_status_changes_in_project(Path::new(&project_path), area, file_path.as_deref())
}

#[tauri::command]
pub fn commit_git_changes(project_path: String, message: String) -> Result<String, String> {
    commit_git_changes_in_project(Path::new(&project_path), &message)
}

#[tauri::command]
pub fn push_git_branch(project_path: String) -> Result<(), String> {
    push_git_branch_in_project(Path::new(&project_path))
}

#[tauri::command]
pub async fn generate_git_commit_message(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<GitCommitMessageSuggestion, String> {
    let config = state.config.lock().unwrap().clone();
    generate_git_commit_message_in_project(Path::new(&project_path), &config).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_commit_message_prompt, build_commit_message_prompt_in_project,
        checkout_git_branch_in_project, clean_commit_message, commit_git_changes_in_project,
        create_git_branch_in_project, decode_text_bytes, parse_anthropic_commit_message_response,
        parse_openai_commit_message_response, push_git_branch_in_project,
        read_git_changed_files_for_tree, read_git_repository_state, read_git_status_change_detail,
        read_git_status_changes, revert_git_status_changes_in_project,
        select_commit_message_provider, stage_git_status_changes_for_paths,
        unstage_git_status_changes_for_paths, GitStatusArea,
    };
    use crate::config::types::{AppConfig, Provider};
    use std::fs;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn temp_project() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("codemux-git-diff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn configure_git_user(project: &std::path::Path) {
        Command::new("git")
            .arg("-C")
            .arg(project)
            .args(["config", "user.email", "codemux@example.test"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(project)
            .args(["config", "user.name", "CodeMUX"])
            .output()
            .unwrap();
    }

    fn init_project_with_commit(project: &std::path::Path) {
        Command::new("git")
            .arg("-C")
            .arg(project)
            .arg("init")
            .output()
            .unwrap();
        configure_git_user(project);
        fs::write(project.join("README.md"), "hello\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(project)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(project)
            .args(["commit", "-m", "initial"])
            .output()
            .unwrap();
    }

    #[test]
    fn git_text_decoder_falls_back_to_gbk() {
        let gbk_bytes = [0xd6, 0xd0, 0xce, 0xc4, b'\r', b'\n'];

        assert_eq!(decode_text_bytes(&gbk_bytes).as_deref(), Some("中文\n"));
    }

    #[test]
    fn git_repository_state_tracks_current_branch_and_local_branches() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        init_project_with_commit(&project);
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["branch", "feature/test"])
            .output()
            .unwrap();

        let state = read_git_repository_state(&project).unwrap();

        assert!(
            state.current_branch.as_deref() == Some("master")
                || state.current_branch.as_deref() == Some("main")
        );
        assert!(state
            .branches
            .iter()
            .any(|branch| branch.name == "feature/test"));
        assert!(!state.detached);
        assert!(!state.has_uncommitted_changes);

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_branch_create_and_checkout_changes_current_branch() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        init_project_with_commit(&project);

        create_git_branch_in_project(&project, "feature/git-panel", true).unwrap();

        let state = read_git_repository_state(&project).unwrap();
        assert_eq!(state.current_branch.as_deref(), Some("feature/git-panel"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_repository_state_tracks_unpushed_commits_and_pushes_branch() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        let remote = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&remote)
            .args(["init", "--bare"])
            .output()
            .unwrap();
        init_project_with_commit(&project);
        let branch_output = Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        let branch = String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["remote", "add", "origin"])
            .arg(&remote)
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["push", "-u", "origin", &branch])
            .output()
            .unwrap();

        fs::write(project.join("README.md"), "hello\nnext\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["commit", "-m", "feat: local change"])
            .output()
            .unwrap();

        let state = read_git_repository_state(&project).unwrap();
        assert_eq!(state.ahead_count, 1);
        assert!(state.has_unpushed_commits);

        push_git_branch_in_project(&project).unwrap();
        let state = read_git_repository_state(&project).unwrap();
        assert_eq!(state.ahead_count, 0);
        assert!(!state.has_unpushed_commits);

        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(remote);
    }

    #[test]
    fn git_checkout_branch_rejects_dirty_worktree() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        init_project_with_commit(&project);
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["branch", "feature/clean"])
            .output()
            .unwrap();
        fs::write(project.join("README.md"), "dirty\n").unwrap();

        let err = checkout_git_branch_in_project(&project, "feature/clean").unwrap_err();

        assert!(err.contains("请先提交或还原当前修改"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_revert_unstaged_changes_restores_tracked_files() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        init_project_with_commit(&project);
        fs::write(project.join("README.md"), "dirty\n").unwrap();
        fs::write(project.join("fresh.txt"), "new\n").unwrap();

        revert_git_status_changes_in_project(&project, GitStatusArea::Unstaged, None).unwrap();

        assert_eq!(
            fs::read_to_string(project.join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "hello\n"
        );
        // Untracked files are preserved — only tracked file modifications are reverted.
        assert!(project.join("fresh.txt").exists());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_revert_staged_changes_restores_worktree() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        init_project_with_commit(&project);
        fs::write(project.join("README.md"), "dirty\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "README.md"])
            .output()
            .unwrap();

        revert_git_status_changes_in_project(&project, GitStatusArea::Staged, None).unwrap();

        assert_eq!(
            fs::read_to_string(project.join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "hello\n"
        );
        assert!(read_git_status_changes(&project, GitStatusArea::Staged)
            .unwrap()
            .is_empty());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_commit_requires_staged_changes_and_returns_hash() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .arg("init")
            .output()
            .unwrap();
        configure_git_user(&project);

        let empty_err = commit_git_changes_in_project(&project, "feat: empty").unwrap_err();
        assert!(empty_err.contains("没有已暂存修改可提交"));

        fs::write(project.join("new.txt"), "hello\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "."])
            .output()
            .unwrap();

        let hash = commit_git_changes_in_project(&project, "feat: add new file").unwrap();

        assert!(hash.len() >= 7);
        assert!(read_git_status_changes(&project, GitStatusArea::Staged)
            .unwrap()
            .is_empty());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_commit_message_prompt_includes_stat_and_diff() {
        let prompt = build_commit_message_prompt(
            " src/main.ts | 2 +-\n",
            "diff --git a/src/main.ts b/src/main.ts\n+new\n-old\n",
            false,
        );

        assert!(prompt.contains("只输出提交信息本身"));
        assert!(prompt.contains("<type>(可选 scope): <中文标题"));
        assert!(prompt.contains("- <中文要点 1>"));
        assert!(prompt.contains("feat: 增加分支切换入口"));
        assert!(prompt.contains("src/main.ts | 2 +-"));
        assert!(prompt.contains("diff --git"));
        assert!(prompt.contains("Conventional Commits"));
    }

    #[test]
    fn git_commit_message_generation_requires_staged_diff() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .arg("init")
            .output()
            .unwrap();

        let err = build_commit_message_prompt_in_project(&project).unwrap_err();

        assert!(err.contains("没有已暂存修改可生成提交信息"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_commit_message_parser_reads_anthropic_response() {
        let body = serde_json::json!({
            "content": [{ "type": "text", "text": "\"feat: 增加分支控件\"\n\n- 支持切换本地分支\n- 支持创建后检出" }]
        });

        let message = parse_anthropic_commit_message_response(&body).unwrap();

        assert_eq!(
            message,
            "feat: 增加分支控件\n\n- 支持切换本地分支\n- 支持创建后检出"
        );
    }

    #[test]
    fn git_commit_message_parser_reads_openai_response() {
        let body = serde_json::json!({
            "choices": [{ "message": { "content": "```text\nfix: 处理脏工作区切换分支\n\n- 阻止存在未提交修改时切换\n```" } }]
        });

        let message = parse_openai_commit_message_response(&body).unwrap();

        assert_eq!(
            message,
            "fix: 处理脏工作区切换分支\n\n- 阻止存在未提交修改时切换"
        );
    }

    #[test]
    fn git_commit_message_cleaner_keeps_conventional_body() {
        let message = clean_commit_message(
            "提交信息如下：\n\n- docs: 更新 Git 计划\n\n- 补充分支管理说明\n- 记录提交弹窗行为",
        )
        .unwrap();

        assert_eq!(
            message,
            "docs: 更新 Git 计划\n\n- 补充分支管理说明\n- 记录提交弹窗行为"
        );
    }

    #[test]
    fn git_commit_message_provider_uses_active_provider() {
        let active = Provider {
            id: "active".to_string(),
            name: "Active".to_string(),
            api_key: "key".to_string(),
            anthropic_base_url: String::new(),
            openai_base_url: "https://api.openai.com".to_string(),
            default_model: "gpt-test".to_string(),
            models: Vec::new(),
            context_1m: None,
            codex_needs_proxy: None,
        };
        let fallback = Provider {
            id: "fallback".to_string(),
            name: "Fallback".to_string(),
            api_key: "key".to_string(),
            anthropic_base_url: "https://api.anthropic.com".to_string(),
            openai_base_url: String::new(),
            default_model: "claude-test".to_string(),
            models: Vec::new(),
            context_1m: None,
            codex_needs_proxy: None,
        };
        let config = AppConfig {
            providers: vec![fallback, active],
            active_provider_id: Some("active".to_string()),
            ..AppConfig::default()
        };

        let provider = select_commit_message_provider(&config).unwrap();

        assert_eq!(provider.id, "active");
    }

    #[test]
    fn git_commit_message_provider_requires_credentials() {
        let config = AppConfig::default();

        let err = select_commit_message_provider(&config).unwrap_err();

        assert!(err.contains("API Key"));
    }

    #[test]
    fn git_tree_diff_tracks_modified_added_and_deleted_files_without_committing() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .arg("init")
            .output()
            .unwrap();
        fs::write(project.join("modified.txt"), "one\ntwo\n").unwrap();
        fs::write(project.join("deleted.txt"), "gone\n").unwrap();

        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "-A"])
            .output()
            .unwrap();
        let baseline_tree = Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["write-tree"])
            .output()
            .unwrap();
        let baseline_tree = String::from_utf8_lossy(&baseline_tree.stdout)
            .trim()
            .to_string();

        fs::write(project.join("modified.txt"), "ONE\ntwo\nTHREE\n").unwrap();
        fs::remove_file(project.join("deleted.txt")).unwrap();
        fs::write(project.join("added.txt"), "new\n").unwrap();

        let changed = read_git_changed_files_for_tree(&project, &baseline_tree).unwrap();
        let paths: Vec<_> = changed
            .iter()
            .map(|file| (file.status.as_str(), file.path.ends_with(".txt")))
            .collect();
        assert_eq!(paths.len(), 3);
        assert!(paths.iter().all(|(_, is_txt)| *is_txt));

        let modified = changed
            .iter()
            .find(|file| file.path.ends_with("modified.txt"))
            .unwrap();
        assert_eq!(modified.status, "modified");
        assert_eq!(modified.original_content.as_deref(), Some("one\ntwo\n"));
        assert_eq!(modified.current_content, "ONE\ntwo\nTHREE\n");

        let added = changed
            .iter()
            .find(|file| file.path.ends_with("added.txt"))
            .unwrap();
        assert_eq!(added.status, "added");
        assert_eq!(added.original_content, None);
        assert_eq!(added.current_content, "new\n");

        let deleted = changed
            .iter()
            .find(|file| file.path.ends_with("deleted.txt"))
            .unwrap();
        assert_eq!(deleted.status, "deleted");
        assert_eq!(deleted.original_content.as_deref(), Some("gone\n"));
        assert_eq!(deleted.current_content, "");

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_status_changes_separates_staged_and_unstaged_files() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .arg("init")
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["config", "user.email", "codemux@example.test"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["config", "user.name", "CodeMUX"])
            .output()
            .unwrap();

        fs::write(project.join("tracked.txt"), "one\n").unwrap();
        fs::write(project.join("staged.txt"), "old\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["commit", "-m", "initial"])
            .output()
            .unwrap();

        fs::write(project.join("staged.txt"), "new\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "staged.txt"])
            .output()
            .unwrap();

        fs::write(project.join("tracked.txt"), "two\n").unwrap();
        fs::write(project.join("untracked.txt"), "fresh\n").unwrap();

        let staged = read_git_status_changes(&project, GitStatusArea::Staged).unwrap();
        let unstaged = read_git_status_changes(&project, GitStatusArea::Unstaged).unwrap();

        assert_eq!(staged.len(), 1);
        assert!(staged[0].path.ends_with("staged.txt"));
        assert!(!staged[0].path.contains(r"\\?\"));
        assert!(!staged[0].path.contains("//?/"));
        assert_eq!(staged[0].original_content, None);
        assert_eq!(staged[0].current_content, "");
        assert_eq!(staged[0].additions, 1);
        assert_eq!(staged[0].deletions, 1);

        let staged_detail =
            read_git_status_change_detail(&project, GitStatusArea::Staged, &staged[0].path)
                .unwrap();
        assert_eq!(staged_detail.original_content.as_deref(), Some("old\n"));
        assert_eq!(staged_detail.current_content, "new\n");

        let unstaged_paths: Vec<_> = unstaged
            .iter()
            .map(|file| file.path.rsplit('/').next().unwrap_or(""))
            .collect();
        assert_eq!(unstaged_paths.len(), 2);
        assert!(unstaged_paths.contains(&"tracked.txt"));
        assert!(unstaged_paths.contains(&"untracked.txt"));
        assert!(unstaged.iter().all(|file| !file.path.contains(r"\\?\")));
        assert!(unstaged.iter().all(|file| !file.path.contains("//?/")));
        assert!(unstaged.iter().all(|file| file.original_content.is_none()));
        assert!(unstaged.iter().all(|file| file.current_content.is_empty()));

        let tracked = unstaged
            .iter()
            .find(|file| file.path.ends_with("tracked.txt"))
            .unwrap();
        assert_eq!(tracked.additions, 1);
        assert_eq!(tracked.deletions, 1);
        let tracked_detail =
            read_git_status_change_detail(&project, GitStatusArea::Unstaged, &tracked.path)
                .unwrap();
        assert_eq!(tracked_detail.original_content.as_deref(), Some("one\n"));
        assert_eq!(tracked_detail.current_content, "two\n");

        let untracked = unstaged
            .iter()
            .find(|file| file.path.ends_with("untracked.txt"))
            .unwrap();
        assert_eq!(untracked.additions, 1);
        assert_eq!(untracked.deletions, 0);

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn git_status_staging_actions_move_files_between_areas() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .arg("init")
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["config", "user.email", "codemux@example.test"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["config", "user.name", "CodeMUX"])
            .output()
            .unwrap();

        fs::write(project.join("a.txt"), "one\n").unwrap();
        fs::write(project.join("b.txt"), "two\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["commit", "-m", "initial"])
            .output()
            .unwrap();

        fs::write(project.join("a.txt"), "ONE\n").unwrap();
        fs::write(project.join("b.txt"), "TWO\n").unwrap();

        let file_a = project.join("a.txt").to_string_lossy().to_string();
        stage_git_status_changes_for_paths(&project, Some(&file_a)).unwrap();

        let staged = read_git_status_changes(&project, GitStatusArea::Staged).unwrap();
        let unstaged = read_git_status_changes(&project, GitStatusArea::Unstaged).unwrap();
        assert_eq!(staged.len(), 1);
        assert!(staged[0].path.ends_with("a.txt"));
        assert_eq!(unstaged.len(), 1);
        assert!(unstaged[0].path.ends_with("b.txt"));

        unstage_git_status_changes_for_paths(&project, Some(&file_a)).unwrap();

        let staged = read_git_status_changes(&project, GitStatusArea::Staged).unwrap();
        let unstaged = read_git_status_changes(&project, GitStatusArea::Unstaged).unwrap();
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 2);

        stage_git_status_changes_for_paths(&project, None).unwrap();
        assert_eq!(
            read_git_status_changes(&project, GitStatusArea::Staged)
                .unwrap()
                .len(),
            2
        );

        unstage_git_status_changes_for_paths(&project, None).unwrap();
        assert!(read_git_status_changes(&project, GitStatusArea::Staged)
            .unwrap()
            .is_empty());

        let _ = fs::remove_dir_all(project);
    }
}
