use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Empty tree hash — the tree object git uses for a repo with zero commits.
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf899d69f3612f4bf";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeBaseline {
    pub project_root: String,
    pub baseline_tree: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub original_content: Option<String>,
    pub current_content: String,
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
    root.join(relative_path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn create_git_baseline_for_path(project_path: &Path) -> Result<GitChangeBaseline, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    ensure_git_repo(&root)?;

    let index_file = temp_index_path();
    let add_result = run_git_with_env(&root, &["add", "-A", "--", "."], Some(&index_file));
    if let Err(err) = add_result {
        let _ = std::fs::remove_file(&index_file);
        return Err(err);
    }

    let tree = match run_git_with_env(&root, &["write-tree"], Some(&index_file)) {
        Ok(output) => String::from_utf8_lossy(&output).trim().to_string(),
        Err(err) => {
            let _ = std::fs::remove_file(&index_file);
            return Err(err);
        }
    };
    let _ = std::fs::remove_file(&index_file);

    Ok(GitChangeBaseline {
        project_root: root.to_string_lossy().replace('\\', "/"),
        baseline_tree: tree,
    })
}

fn read_tree_file(root: &Path, tree: &str, relative_path: &str) -> Result<Option<String>, String> {
    match run_git(root, &["show", &format!("{}:{}", tree, relative_path)]) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(content) => Ok(Some(normalize_line_endings(&content))),
            Err(_) => Ok(None),
        },
        Err(_) => Ok(None),
    }
}

/// Normalize CRLF to LF for consistent comparison
fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n")
}

pub fn read_git_changed_files_for_tree(
    project_path: &Path,
    baseline_tree: &str,
) -> Result<Vec<GitChangedFile>, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    ensure_git_repo(&root)?;

    // Use git diff to get only changed files (much faster than comparing all files)
    let diff_output = run_git(
        &root,
        &["diff", "--name-status", "--no-renames", baseline_tree],
    )?;
    let diff_text = String::from_utf8_lossy(&diff_output);

    // Also get untracked files
    let untracked_output = run_git(
        &root,
        &["ls-files", "-o", "--exclude-standard", "-z"],
    )?;
    let untracked_paths = parse_nul_paths(&untracked_output);

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
            match std::fs::read_to_string(&absolute_path) {
                Ok(content) => Some(normalize_line_endings(&content)),
                Err(_) => None,
            }
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

    // Add untracked files
    for relative_path in untracked_paths {
        let absolute_path = root.join(&relative_path);
        if !absolute_path.is_file() {
            continue;
        }
        let current = match std::fs::read_to_string(&absolute_path) {
            Ok(content) => Some(normalize_line_endings(&content)),
            Err(_) => None,
        };
        if let Some(content) = current {
            changed_files.push(GitChangedFile {
                path: relative_path_to_absolute(&root, &relative_path),
                status: "added".to_string(),
                original_content: None,
                current_content: content,
            });
        }
    }

    Ok(changed_files)
}

#[tauri::command]
pub fn create_git_change_baseline(project_path: String) -> Result<GitChangeBaseline, String> {
    create_git_baseline_for_path(Path::new(&project_path))
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

#[cfg(test)]
mod tests {
    use super::{create_git_baseline_for_path, read_git_changed_files_for_tree};
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
    fn git_baseline_tracks_modified_added_and_deleted_files_without_committing() {
        if !git_available() {
            return;
        }

        let project = temp_project();
        fs::write(project.join("modified.txt"), "one\ntwo\n").unwrap();
        fs::write(project.join("deleted.txt"), "gone\n").unwrap();

        let baseline = create_git_baseline_for_path(&project).unwrap();
        assert!(project.join(".git").is_dir());

        fs::write(project.join("modified.txt"), "ONE\ntwo\nTHREE\n").unwrap();
        fs::remove_file(project.join("deleted.txt")).unwrap();
        fs::write(project.join("added.txt"), "new\n").unwrap();

        let changed = read_git_changed_files_for_tree(&project, &baseline.baseline_tree).unwrap();
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
}
