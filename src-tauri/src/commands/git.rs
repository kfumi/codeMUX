use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Empty tree hash — the tree object git uses for a repo with zero commits.
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf899d69f3612f4bf";

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

fn ensure_git_repo(root: &Path) -> Result<(), String> {
    if run_git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(());
    }
    run_git(root, &["init"]).map(|_| ())
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

fn git_head_tree(root: &Path) -> Result<String, String> {
    match run_git(root, &["rev-parse", "HEAD^{tree}"]) {
        Ok(output) => Ok(String::from_utf8_lossy(&output).trim().to_string()),
        Err(_) => Ok(EMPTY_TREE_HASH.to_string()),
    }
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
    head_tree: &str,
) -> Result<HashMap<String, (usize, usize)>, String> {
    let args: Vec<&str> = match area {
        GitStatusArea::Unstaged => vec!["diff", "--numstat", "--no-renames"],
        GitStatusArea::Staged => vec!["diff", "--cached", "--numstat", "--no-renames", head_tree],
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
    ensure_git_repo(&root)?;

    let head_tree = git_head_tree(&root)?;
    let args: Vec<&str> = match area {
        GitStatusArea::Unstaged => vec!["diff", "--name-status", "--no-renames"],
        GitStatusArea::Staged => vec![
            "diff",
            "--cached",
            "--name-status",
            "--no-renames",
            &head_tree,
        ],
    };
    let diff_output = run_git(&root, &args)?;
    let diff_text = String::from_utf8_lossy(&diff_output);
    let numstat = git_numstat_map(&root, area, &head_tree)?;
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
    ensure_git_repo(&root)?;

    let relative_path = path_to_repo_relative(&root, file_path);
    let summary = read_git_status_changes(&root, area)?
        .into_iter()
        .find(|change| path_to_repo_relative(&root, &change.path) == relative_path)
        .ok_or_else(|| format!("No git change found for {}", file_path))?;

    let head_tree = git_head_tree(&root)?;
    let original = match area {
        GitStatusArea::Staged => {
            if summary.status != "added" {
                read_tree_file(&root, &head_tree, &relative_path)?
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
    ensure_git_repo(&root)?;

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
    ensure_git_repo(&root)?;

    let head_tree = git_head_tree(&root)?;
    match file_path {
        Some(file_path) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(&root, &["reset", "-q", &head_tree, "--", &relative_path]).map(|_| ())
        }
        None => run_git(&root, &["reset", "-q", &head_tree, "--", "."]).map(|_| ()),
    }
}

pub fn read_git_changed_files_for_tree(
    project_path: &Path,
    baseline_tree: &str,
) -> Result<Vec<GitChangedFile>, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    ensure_git_repo(&root)?;

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

    // Get the HEAD tree hash; fall back to empty tree for repos with no commits
    let head_tree = match run_git(&root, &["rev-parse", "HEAD^{tree}"]) {
        Ok(output) => String::from_utf8_lossy(&output).trim().to_string(),
        Err(_) => EMPTY_TREE_HASH.to_string(),
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
pub fn stage_git_status_changes(project_path: String, file_path: Option<String>) -> Result<(), String> {
    stage_git_status_changes_for_paths(Path::new(&project_path), file_path.as_deref())
}

#[tauri::command]
pub fn unstage_git_status_changes(project_path: String, file_path: Option<String>) -> Result<(), String> {
    unstage_git_status_changes_for_paths(Path::new(&project_path), file_path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_text_bytes, read_git_changed_files_for_tree, read_git_status_change_detail,
        read_git_status_changes, stage_git_status_changes_for_paths,
        unstage_git_status_changes_for_paths, GitStatusArea,
    };
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

    #[test]
    fn git_text_decoder_falls_back_to_gbk() {
        let gbk_bytes = [0xd6, 0xd0, 0xce, 0xc4, b'\r', b'\n'];

        assert_eq!(decode_text_bytes(&gbk_bytes).as_deref(), Some("中文\n"));
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
            .args(["config", "user.name", "codeMUX"])
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
            .args(["config", "user.name", "codeMUX"])
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
