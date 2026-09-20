//! 工作任务的 git 隔离/合并操作。`services::git` 面向前端工作区功能，这里
//! 只补工作任务需要的缺口：diff 统计、work 分支合并、worktree/分支清理与
//! 重置。全部走 `std::process::Command`，纯同步、可独立测试。

use std::path::Path;

/// 合并失败分类：冲突（回 review 由人工处理）与其他 git 错误。
#[derive(Debug)]
pub enum MergeError {
    Conflict,
    Other(String),
}

pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// 同步执行一条 git 命令；仅进程级失败（git 不存在等）返回 Err，
/// git 自身的非零退出码由调用方经 `output.success` 判定。
pub(crate) fn git_raw(dir: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|error| format!("无法执行 git: {error}"))?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_raw(dir, args)?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(format!(
            "git {} 失败: {}",
            args.join(" "),
            output.stderr.trim()
        ))
    }
}

/// 项目当前分支；detached HEAD 或非仓库报错。
pub fn current_branch(project_path: &Path) -> Result<String, String> {
    let branch = run_git(project_path, &["branch", "--show-current"])?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("当前处于 detached HEAD，无法确定基准分支".to_string());
    }
    Ok(branch)
}
/// 解析引用当前 HEAD sha（`git rev-parse <ref>`）；失败（分支不存在/非仓库）报错。
pub fn rev_parse(project_path: &Path, reference: &str) -> Result<String, String> {
    Ok(run_git(project_path, &["rev-parse", reference])?
        .trim()
        .to_string())
}

/// `git diff --numstat <base>...<work>` → (files_changed, additions, deletions)。
/// 二进制行（`-\t-`）不计入行数，但计入文件数。
pub fn diff_numstat(
    project_path: &Path,
    base: &str,
    work: &str,
) -> Result<(i64, i64, i64), String> {
    let output = run_git(
        project_path,
        &["diff", "--numstat", &format!("{base}...{work}")],
    )?;
    let mut files = 0i64;
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for line in output.lines() {
        let mut parts = line.split('\t');
        let (added, deleted) = match (parts.next(), parts.next()) {
            (Some(added), Some(deleted)) => (added, deleted),
            _ => continue,
        };
        files += 1;
        if let Ok(value) = added.parse::<i64>() {
            additions += value;
        }
        if let Ok(value) = deleted.parse::<i64>() {
            deletions += value;
        }
    }
    Ok((files, additions, deletions))
}

/// 在临时 detached worktree 里把 `work` no-ff 合并进 `base`，返回 merge commit。
///
/// detached 临时检出绕开「base 已被主 checkout 占用」的限制；合并成功后用
/// `git update-ref` 把 `base` 分支引用前进到 merge commit（不触碰主 checkout
/// 的工作区文件，主 checkout 显示为「落后」待拉取）。冲突时清理临时 worktree
/// 并返回 [`MergeError::Conflict`]。
pub fn merge_work_branch(
    project_path: &Path,
    base_branch: &str,
    work_branch: &str,
    message: &str,
) -> Result<String, MergeError> {
    let tmp = std::env::temp_dir().join(format!("codemux-merge-{}", uuid::Uuid::new_v4()));
    let tmp_display = tmp.to_string_lossy().to_string();
    let finish = |error: MergeError| -> MergeError {
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = git_raw(project_path, &["worktree", "prune"]);
        error
    };

    let added = match git_raw(
        project_path,
        &["worktree", "add", "--detach", &tmp_display, base_branch],
    ) {
        Ok(output) if output.success => output,
        Ok(output) => return Err(finish(MergeError::Other(output.stderr))),
        Err(error) => return Err(finish(MergeError::Other(error))),
    };
    if !added.success {
        return Err(finish(MergeError::Other(added.stderr)));
    }

    let merge = match git_raw(
        Path::new(&tmp),
        &["merge", "--no-ff", work_branch, "-m", message],
    ) {
        Ok(output) if output.success => output,
        Ok(output) => {
            let combined = format!("{}{}", output.stdout, output.stderr).to_lowercase();
            let _ = git_raw(
                project_path,
                &["worktree", "remove", "--force", &tmp_display],
            );
            return Err(finish(if combined.contains("conflict") {
                MergeError::Conflict
            } else {
                MergeError::Other(format!(
                    "git merge 失败: {}{}",
                    output.stdout, output.stderr
                ))
            }));
        }
        Err(error) => return Err(finish(MergeError::Other(error))),
    };
    let _ = merge;

    let head = match git_raw(Path::new(&tmp), &["rev-parse", "HEAD"]) {
        Ok(output) if output.success => output.stdout.trim().to_string(),
        Ok(output) => {
            let _ = git_raw(
                project_path,
                &["worktree", "remove", "--force", &tmp_display],
            );
            return Err(finish(MergeError::Other(output.stderr)));
        }
        Err(error) => return Err(finish(MergeError::Other(error))),
    };
    let _ = git_raw(project_path, &["worktree", "remove", &tmp_display]);
    let _ = git_raw(project_path, &["worktree", "prune"]);
    // base 分支引用前进到 merge commit（detached 临时检出不会自动推进 ref）
    let update = match git_raw(
        project_path,
        &["update-ref", &format!("refs/heads/{base_branch}"), &head],
    ) {
        Ok(output) if output.success => output,
        Ok(output) => return Err(finish(MergeError::Other(output.stderr))),
        Err(error) => return Err(finish(MergeError::Other(error))),
    };
    let _ = update;
    Ok(head)
}

/// 删除任务 worktree 与 work 分支（合并完成后清理）。失败不影响任务终态。
pub fn cleanup_worktree_and_branch(
    project_path: &Path,
    worktree_path: &str,
    work_branch: &str,
) -> Result<(), String> {
    let removed = match git_raw(
        project_path,
        &["worktree", "remove", "--force", worktree_path],
    ) {
        Ok(output) if output.success => None,
        Ok(output) => Some(format!("worktree remove: {}", output.stderr.trim())),
        Err(error) => Some(error),
    };
    let _ = git_raw(project_path, &["worktree", "prune"]);
    let branch = match git_raw(project_path, &["branch", "-D", work_branch]) {
        Ok(output) if output.success => None,
        Ok(output) => Some(format!("branch -D: {}", output.stderr.trim())),
        Err(error) => Some(error),
    };
    match removed.or(branch) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 重启前把 worktree 重置回 base 分支：hard reset + clean。
pub fn reset_worktree_to_base(worktree_path: &Path, base_branch: &str) -> Result<(), String> {
    run_git(worktree_path, &["reset", "--hard", base_branch])?;
    run_git(worktree_path, &["clean", "-fd"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        git_raw(dir, args)
            .and_then(|output| {
                if output.success {
                    Ok(output.stdout)
                } else {
                    Err(format!("git {args:?}: {}", output.stderr))
                }
            })
            .unwrap_or_else(|error| panic!("{error}"));
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        git_raw(dir, args)
            .and_then(|output| {
                if output.success {
                    Ok(output.stdout)
                } else {
                    Err(format!("git {args:?}: {}", output.stderr))
                }
            })
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn commit_file(dir: &Path, name: &str, content: &str, message: &str) {
        std::fs::write(dir.join(name), content).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", message]);
    }

    fn init_repo(base_branch: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", base_branch]);
        git(dir.path(), &["config", "user.name", "t"]);
        git(dir.path(), &["config", "user.email", "t@t"]);
        git(dir.path(), &["commit", "--allow-empty", "-m", "init"]);
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    fn base_ref_of(root: &Path, branch: &str) -> String {
        git_out(root, &["rev-parse", branch]).trim().to_string()
    }

    #[test]
    fn merge_success_advances_base_ref_and_reports_commit() {
        if !git_available() {
            eprintln!("git 不可用，跳过");
            return;
        }
        let (_dir, root) = init_repo("main");
        let base_before = base_ref_of(&root, "main");
        git(&root, &["checkout", "-b", "worktask/t1"]);
        commit_file(&root, "a.txt", "hello\n", "work");
        git(&root, &["checkout", "main"]);

        let commit = merge_work_branch(&root, "main", "worktask/t1", "merge test").unwrap();
        assert!(!commit.is_empty());

        // base 分支引用已前进到 merge commit
        assert_eq!(base_ref_of(&root, "main"), commit);
        assert_ne!(base_ref_of(&root, "main"), base_before);
        assert!(git_out(&root, &["log", "--oneline", "main"]).contains("merge test"));

        // 临时 worktree 已清理
        let worktrees = git_out(&root, &["worktree", "list"]);
        assert_eq!(worktrees.lines().count(), 1);
    }

    #[test]
    fn merge_conflict_returns_conflict_and_keeps_base_ref() {
        if !git_available() {
            eprintln!("git 不可用，跳过");
            return;
        }
        let (_dir, root) = init_repo("main");
        commit_file(&root, "conflict.txt", "base\n", "base file");

        git(&root, &["checkout", "-b", "worktask/t2"]);
        commit_file(&root, "conflict.txt", "work change\n", "work change");

        git(&root, &["checkout", "main"]);
        commit_file(&root, "conflict.txt", "main change\n", "main change");
        let base_at_merge = base_ref_of(&root, "main");

        let error = merge_work_branch(&root, "main", "worktask/t2", "merge").unwrap_err();
        assert!(matches!(error, MergeError::Conflict), "{error:?}");

        // base 引用未前进、临时 worktree 已清理
        assert_eq!(base_ref_of(&root, "main"), base_at_merge);
        let worktrees = git_out(&root, &["worktree", "list"]);
        assert_eq!(worktrees.lines().count(), 1);
        git(&root, &["checkout", "main"]);
        let content = std::fs::read_to_string(root.join("conflict.txt")).unwrap();
        assert_eq!(content, "main change\n");
    }

    #[test]
    fn diff_numstat_counts_files_and_lines() {
        if !git_available() {
            eprintln!("git 不可用，跳过");
            return;
        }
        let (_dir, root) = init_repo("main");
        git(&root, &["checkout", "-b", "worktask/t3"]);
        commit_file(&root, "x.txt", "a\nb\nc\n", "add x");
        commit_file(&root, "y.txt", "1\n", "add y");

        let (files, additions, deletions) = diff_numstat(&root, "main", "worktask/t3").unwrap();
        assert_eq!(files, 2);
        assert_eq!(additions, 4);
        assert_eq!(deletions, 0);
    }

    #[test]
    fn reset_worktree_restores_base_state() {
        if !git_available() {
            eprintln!("git 不可用，跳过");
            return;
        }
        let (tmp_repo, root) = init_repo("main");
        let worktree = tmp_repo.path().join("wt");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "worktask/t4",
                &worktree.to_string_lossy(),
                "main",
            ],
        );
        std::fs::write(worktree.join("dirty.txt"), "dirty\n").unwrap();
        git(&worktree, &["add", "."]);
        std::fs::write(worktree.join("untracked.txt"), "u\n").unwrap();

        reset_worktree_to_base(&worktree, "main").unwrap();
        assert!(!worktree.join("dirty.txt").exists());
        assert!(!worktree.join("untracked.txt").exists());
    }
}
