# Git Branch Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧审查面板中增加本地 Git 分支创建/切换、修改还原、提交和 AI 提交信息生成能力。

**Architecture:** Rust/Tauri 后端继续作为唯一 Git 执行边界，前端通过 `gitApi` 调用新增命令。`ReviewPanel` 只负责编排状态，新增小组件承载分支栏、提交区和确认流程，避免主组件继续膨胀。

**Tech Stack:** Tauri 2、Rust、React 18、TypeScript、Vitest、Testing Library、lucide-react、现有 shadcn/Radix UI 组件。

---

## 文件结构

- 修改 `src-tauri/src/commands/git.rs`
  - 新增仓库状态、分支创建/切换、还原、提交、提交信息生成的纯函数和 Tauri 命令。
  - 扩展现有 Git 临时仓库单测。
- 修改 `src-tauri/src/lib.rs`
  - 注册新增 Tauri 命令。
- 修改 `src/lib/tauri.ts`
  - 新增 Git 类型和 `gitApi` 方法。
- 修改 `src/lib/tauri.test.ts`
  - 覆盖新增 invoke 命令名和参数映射。
- 修改 `src/components/workspace/review/ReviewPanel.tsx`
  - 接入仓库状态、还原、提交和刷新编排。
- 新增 `src/components/workspace/review/GitBranchBar.tsx`
  - 显示当前分支、本地分支列表、新建分支入口和刷新按钮。
- 新增 `src/components/workspace/review/GitBranchDialog.tsx`
  - 输入新分支名，默认创建后检出。
- 新增 `src/components/workspace/review/GitCommitBox.tsx`
  - 提交信息输入、AI 生成按钮、提交按钮。
- 修改 `src/components/workspace/review/ReviewPanel.test.tsx`
  - 覆盖新交互。

## Task 1: 后端 Git 仓库状态与分支操作

**Files:**
- Modify: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的 Rust 测试**

在 `src-tauri/src/commands/git.rs` 的 `tests` 模块导入新增函数名：

```rust
use super::{
    checkout_git_branch_in_project, create_git_branch_in_project, read_git_repository_state,
};
```

新增测试：

```rust
#[test]
fn git_repository_state_tracks_current_branch_and_local_branches() {
    if !git_available() {
        return;
    }

    let project = temp_project();
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();
    fs::write(project.join("README.md"), "hello\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["commit", "-m", "initial"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["branch", "feature/test"]).output().unwrap();

    let state = read_git_repository_state(&project).unwrap();

    assert!(state.current_branch.as_deref() == Some("master") || state.current_branch.as_deref() == Some("main"));
    assert!(state.branches.iter().any(|branch| branch.name == "feature/test"));
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
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();
    fs::write(project.join("README.md"), "hello\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["commit", "-m", "initial"]).output().unwrap();

    create_git_branch_in_project(&project, "feature/git-panel", true).unwrap();

    let state = read_git_repository_state(&project).unwrap();
    assert_eq!(state.current_branch.as_deref(), Some("feature/git-panel"));

    let _ = fs::remove_dir_all(project);
}

#[test]
fn git_checkout_branch_rejects_dirty_worktree() {
    if !git_available() {
        return;
    }

    let project = temp_project();
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();
    fs::write(project.join("README.md"), "hello\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["commit", "-m", "initial"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["branch", "feature/clean"]).output().unwrap();
    fs::write(project.join("README.md"), "dirty\n").unwrap();

    let err = checkout_git_branch_in_project(&project, "feature/clean").unwrap_err();

    assert!(err.contains("请先提交或还原当前修改"));

    let _ = fs::remove_dir_all(project);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd src-tauri
cargo test git_repository_state_tracks_current_branch_and_local_branches git_branch_create_and_checkout_changes_current_branch git_checkout_branch_rejects_dirty_worktree
```

Expected: 编译失败，提示 `read_git_repository_state`、`create_git_branch_in_project` 或 `checkout_git_branch_in_project` 未定义。

- [ ] **Step 3: 实现仓库状态和分支函数**

在 `src-tauri/src/commands/git.rs` 的 `GitStatusChange` 后添加：

```rust
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
}
```

在 helper 函数区添加：

```rust
fn has_uncommitted_changes(root: &Path) -> Result<bool, String> {
    let output = run_git(root, &["status", "--porcelain=v1"])?;
    Ok(!output.is_empty())
}

fn validate_branch_name(root: &Path, branch_name: &str) -> Result<String, String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    run_git(root, &["check-ref-format", "--branch", trimmed])?;
    Ok(trimmed.to_string())
}

pub fn read_git_repository_state(project_path: &Path) -> Result<GitRepositoryState, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    ensure_git_repo(&root)?;

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

    let detached = current_branch.is_none() && run_git(&root, &["rev-parse", "--short", "HEAD"]).is_ok();

    Ok(GitRepositoryState {
        current_branch,
        branches,
        detached,
        has_uncommitted_changes: has_uncommitted_changes(&root)?,
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
    ensure_git_repo(&root)?;
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
    ensure_git_repo(&root)?;
    let branch_name = validate_branch_name(&root, branch_name)?;
    if has_uncommitted_changes(&root)? {
        return Err("请先提交或还原当前修改，再切换分支".to_string());
    }
    run_git(&root, &["checkout", &branch_name]).map(|_| ())
}
```

在 Tauri 命令区添加：

```rust
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
```

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册：

```rust
commands::git::get_git_repository_state,
commands::git::create_git_branch,
commands::git::checkout_git_branch,
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
cd src-tauri
cargo test git_repository_state_tracks_current_branch_and_local_branches git_branch_create_and_checkout_changes_current_branch git_checkout_branch_rejects_dirty_worktree
```

Expected: 3 个测试 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add branch state commands"
```

## Task 2: 后端还原与提交能力

**Files:**
- Modify: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的 Rust 测试**

在 `tests` 模块导入：

```rust
use super::{commit_git_changes_in_project, revert_git_status_changes_in_project};
```

新增测试：

```rust
#[test]
fn git_revert_unstaged_changes_restores_tracked_and_removes_untracked() {
    if !git_available() {
        return;
    }

    let project = temp_project();
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();
    fs::write(project.join("tracked.txt"), "one\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["commit", "-m", "initial"]).output().unwrap();
    fs::write(project.join("tracked.txt"), "two\n").unwrap();
    fs::write(project.join("fresh.txt"), "new\n").unwrap();

    revert_git_status_changes_in_project(&project, GitStatusArea::Unstaged, None).unwrap();

    assert_eq!(fs::read_to_string(project.join("tracked.txt")).unwrap(), "one\n");
    assert!(!project.join("fresh.txt").exists());

    let _ = fs::remove_dir_all(project);
}

#[test]
fn git_revert_staged_changes_restores_worktree() {
    if !git_available() {
        return;
    }

    let project = temp_project();
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();
    fs::write(project.join("tracked.txt"), "one\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["commit", "-m", "initial"]).output().unwrap();
    fs::write(project.join("tracked.txt"), "two\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "tracked.txt"]).output().unwrap();

    revert_git_status_changes_in_project(&project, GitStatusArea::Staged, None).unwrap();

    assert_eq!(fs::read_to_string(project.join("tracked.txt")).unwrap(), "one\n");
    assert!(read_git_status_changes(&project, GitStatusArea::Staged).unwrap().is_empty());

    let _ = fs::remove_dir_all(project);
}

#[test]
fn git_commit_requires_staged_changes_and_returns_hash() {
    if !git_available() {
        return;
    }

    let project = temp_project();
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.email", "codemux@example.test"]).output().unwrap();
    Command::new("git").arg("-C").arg(&project).args(["config", "user.name", "codeMUX"]).output().unwrap();

    let empty_err = commit_git_changes_in_project(&project, "feat: empty").unwrap_err();
    assert!(empty_err.contains("没有已暂存修改可提交"));

    fs::write(project.join("new.txt"), "hello\n").unwrap();
    Command::new("git").arg("-C").arg(&project).args(["add", "."]).output().unwrap();

    let hash = commit_git_changes_in_project(&project, "feat: add new file").unwrap();

    assert!(hash.len() >= 7);
    assert!(read_git_status_changes(&project, GitStatusArea::Staged).unwrap().is_empty());

    let _ = fs::remove_dir_all(project);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd src-tauri
cargo test git_revert_unstaged_changes_restores_tracked_and_removes_untracked git_revert_staged_changes_restores_worktree git_commit_requires_staged_changes_and_returns_hash
```

Expected: 编译失败，提示还原和提交函数未定义。

- [ ] **Step 3: 实现还原与提交**

在 `src-tauri/src/commands/git.rs` 添加 helper：

```rust
fn is_untracked_file(root: &Path, relative_path: &str) -> Result<bool, String> {
    let output = run_git(root, &["ls-files", "--others", "--exclude-standard", "--", relative_path])?;
    Ok(!String::from_utf8_lossy(&output).trim().is_empty())
}

fn remove_untracked_path(root: &Path, relative_path: &str) -> Result<(), String> {
    let target = root.join(relative_path);
    if target.is_file() {
        std::fs::remove_file(&target).map_err(|e| format!("Failed to delete {}: {}", relative_path, e))?;
    } else if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete {}: {}", relative_path, e))?;
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
    ensure_git_repo(&root)?;

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
            run_git(&root, &["restore", "--worktree", "--", "."])?;
            run_git(&root, &["clean", "-fd", "--", "."]).map(|_| ())
        }
        (GitStatusArea::Staged, Some(file_path)) => {
            let relative_path = path_to_repo_relative(&root, file_path);
            run_git(&root, &["restore", "--staged", "--worktree", "--", &relative_path]).map(|_| ())
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
    ensure_git_repo(&root)?;
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
```

添加 Tauri 命令：

```rust
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
```

在 `src-tauri/src/lib.rs` 注册：

```rust
commands::git::revert_git_status_changes,
commands::git::commit_git_changes,
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
cd src-tauri
cargo test git_revert_unstaged_changes_restores_tracked_and_removes_untracked git_revert_staged_changes_restores_worktree git_commit_requires_staged_changes_and_returns_hash
```

Expected: 3 个测试 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add revert and commit commands"
```

## Task 3: 提交信息生成命令

**Files:**
- Modify: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的 Rust 测试**

导入：

```rust
use super::{build_commit_message_prompt, generate_git_commit_message_in_project};
```

新增测试：

```rust
#[test]
fn git_commit_message_prompt_includes_stat_and_diff() {
    let prompt = build_commit_message_prompt(
        " src/main.ts | 2 +-\n",
        "diff --git a/src/main.ts b/src/main.ts\n+new\n-old\n",
        false,
    );

    assert!(prompt.contains("只输出一条提交信息"));
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
    Command::new("git").arg("-C").arg(&project).arg("init").output().unwrap();

    let err = generate_git_commit_message_in_project(&project).unwrap_err();

    assert!(err.contains("没有已暂存修改可生成提交信息"));

    let _ = fs::remove_dir_all(project);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd src-tauri
cargo test git_commit_message_prompt_includes_stat_and_diff git_commit_message_generation_requires_staged_diff
```

Expected: 编译失败，提示函数未定义。

- [ ] **Step 3: 实现可测试的提交信息生成**

首版实现为确定性启发式生成，返回可编辑提交信息；真实供应商调用可在后续任务替换 `suggest_commit_message_from_prompt` 内部实现。

在 `src-tauri/src/commands/git.rs` 添加：

```rust
const COMMIT_MESSAGE_DIFF_LIMIT: usize = 12_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessageSuggestion {
    pub message: String,
}

pub fn build_commit_message_prompt(stat: &str, diff: &str, truncated: bool) -> String {
    format!(
        "请根据以下 staged diff 生成一条 Git 提交信息。只输出一条提交信息，不输出解释。优先使用 Conventional Commits，长度不超过 72 个字符。{}\n\n统计:\n{}\n\nDiff:\n{}",
        if truncated { "Diff 内容已截断，请基于可见内容概括。" } else { "" },
        stat.trim(),
        diff.trim()
    )
}

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

pub fn generate_git_commit_message_in_project(
    project_path: &Path,
) -> Result<GitCommitMessageSuggestion, String> {
    let root = project_path
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    ensure_git_repo(&root)?;
    if run_git(&root, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err("没有已暂存修改可生成提交信息".to_string());
    }

    let stat = String::from_utf8_lossy(&run_git(&root, &["diff", "--cached", "--stat"])?).to_string();
    let raw_diff = String::from_utf8_lossy(&run_git(
        &root,
        &["diff", "--cached", "--unified=3", "--no-ext-diff"],
    )?)
    .to_string();
    let truncated = raw_diff.len() > COMMIT_MESSAGE_DIFF_LIMIT;
    let diff = if truncated {
        raw_diff.chars().take(COMMIT_MESSAGE_DIFF_LIMIT).collect::<String>()
    } else {
        raw_diff
    };
    let prompt = build_commit_message_prompt(&stat, &diff, truncated);

    Ok(GitCommitMessageSuggestion {
        message: suggest_commit_message_from_prompt(&prompt),
    })
}
```

添加 Tauri 命令：

```rust
#[tauri::command]
pub fn generate_git_commit_message(
    project_path: String,
) -> Result<GitCommitMessageSuggestion, String> {
    generate_git_commit_message_in_project(Path::new(&project_path))
}
```

在 `src-tauri/src/lib.rs` 注册：

```rust
commands::git::generate_git_commit_message,
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
cd src-tauri
cargo test git_commit_message_prompt_includes_stat_and_diff git_commit_message_generation_requires_staged_diff
```

Expected: 2 个测试 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add commit message suggestion command"
```

## Task 4: 前端 Tauri API 类型与映射

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/tauri.test.ts`

- [ ] **Step 1: 写失败的 Vitest 测试**

在 `src/lib/tauri.test.ts` 的 `describe('gitApi')` 中追加：

```ts
it('maps branch and commit git commands with command argument casing', async () => {
  invokeMock.mockResolvedValue(undefined);
  const { gitApi } = await import('./tauri');

  await gitApi.getRepositoryState('D:/project/app');
  await gitApi.createBranch('D:/project/app', 'feature/git-panel', true);
  await gitApi.checkoutBranch('D:/project/app', 'feature/git-panel');
  await gitApi.revertStatusChanges('D:/project/app', 'unstaged', 'D:/project/app/src/App.tsx');
  await gitApi.commitChanges('D:/project/app', 'feat: add git panel');
  await gitApi.generateCommitMessage('D:/project/app');

  expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_git_repository_state', {
    projectPath: 'D:/project/app',
  });
  expect(invokeMock).toHaveBeenNthCalledWith(2, 'create_git_branch', {
    projectPath: 'D:/project/app',
    branchName: 'feature/git-panel',
    checkout: true,
  });
  expect(invokeMock).toHaveBeenNthCalledWith(3, 'checkout_git_branch', {
    projectPath: 'D:/project/app',
    branchName: 'feature/git-panel',
  });
  expect(invokeMock).toHaveBeenNthCalledWith(4, 'revert_git_status_changes', {
    projectPath: 'D:/project/app',
    area: 'unstaged',
    filePath: 'D:/project/app/src/App.tsx',
  });
  expect(invokeMock).toHaveBeenNthCalledWith(5, 'commit_git_changes', {
    projectPath: 'D:/project/app',
    message: 'feat: add git panel',
  });
  expect(invokeMock).toHaveBeenNthCalledWith(6, 'generate_git_commit_message', {
    projectPath: 'D:/project/app',
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run src/lib/tauri.test.ts
```

Expected: FAIL，提示 `gitApi.getRepositoryState` 等方法不存在。

- [ ] **Step 3: 实现 API 类型与映射**

在 `src/lib/tauri.ts` 的 Git 类型附近添加：

```ts
export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitRepositoryState {
  currentBranch: string | null;
  branches: GitBranch[];
  detached: boolean;
  hasUncommittedChanges: boolean;
}

export interface GitCommitMessageSuggestion {
  message: string;
}
```

扩展 `gitApi`：

```ts
  getRepositoryState: (projectPath: string): Promise<GitRepositoryState> =>
    invokeLogged('get_git_repository_state', { projectPath }),
  createBranch: (projectPath: string, branchName: string, checkout: boolean): Promise<void> =>
    invokeLogged('create_git_branch', { projectPath, branchName, checkout }),
  checkoutBranch: (projectPath: string, branchName: string): Promise<void> =>
    invokeLogged('checkout_git_branch', { projectPath, branchName }),
  revertStatusChanges: (projectPath: string, area: GitStatusArea, filePath?: string): Promise<void> =>
    invokeLogged('revert_git_status_changes', { projectPath, area, filePath: filePath ?? null }),
  commitChanges: (projectPath: string, message: string): Promise<string> =>
    invokeLogged('commit_git_changes', { projectPath, message }),
  generateCommitMessage: (projectPath: string): Promise<GitCommitMessageSuggestion> =>
    invokeLogged('generate_git_commit_message', { projectPath }),
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
npx vitest run src/lib/tauri.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/lib/tauri.ts src/lib/tauri.test.ts
git commit -m "feat(git): expose branch management api"
```

## Task 5: 分支栏和新建分支对话框

**Files:**
- Create: `src/components/workspace/review/GitBranchBar.tsx`
- Create: `src/components/workspace/review/GitBranchDialog.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] **Step 1: 写失败的前端测试**

扩展 `gitApiMock`：

```ts
  getRepositoryState: vi.fn(),
  createBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  revertStatusChanges: vi.fn(),
  commitChanges: vi.fn(),
  generateCommitMessage: vi.fn(),
```

在 `beforeEach` 中添加：

```ts
gitApiMock.getRepositoryState.mockResolvedValue({
  currentBranch: 'master',
  branches: [
    { name: 'master', current: true },
    { name: 'feature/git-panel', current: false },
  ],
  detached: false,
  hasUncommittedChanges: false,
});
gitApiMock.createBranch.mockResolvedValue(undefined);
gitApiMock.checkoutBranch.mockResolvedValue(undefined);
```

新增测试：

```tsx
it('loads repository state and switches branches', async () => {
  render(<ReviewPanel projectPath="D:/project/app" />);

  await screen.findByText('master');
  fireEvent.click(screen.getByRole('button', { name: '切换分支' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'feature/git-panel' }));

  await waitFor(() => expect(gitApiMock.checkoutBranch).toHaveBeenCalledWith('D:/project/app', 'feature/git-panel'));
  await waitFor(() => expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2));
});

it('creates a branch from the branch dialog', async () => {
  render(<ReviewPanel projectPath="D:/project/app" />);

  await screen.findByText('master');
  fireEvent.click(screen.getByRole('button', { name: '新建分支' }));
  fireEvent.change(screen.getByLabelText('分支名'), { target: { value: 'feature/new-work' } });
  fireEvent.click(screen.getByRole('button', { name: '创建分支' }));

  await waitFor(() => expect(gitApiMock.createBranch).toHaveBeenCalledWith('D:/project/app', 'feature/new-work', true));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: FAIL，找不到“master”或新按钮。

- [ ] **Step 3: 创建 `GitBranchDialog.tsx`**

```tsx
import { useState } from 'react';

import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';

interface GitBranchDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (branchName: string, checkout: boolean) => void;
}

export function GitBranchDialog({ open, loading, error, onOpenChange, onCreate }: GitBranchDialogProps) {
  const [branchName, setBranchName] = useState('');
  const [checkout, setCheckout] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-105">
        <DialogHeader>
          <DialogTitle>新建分支</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">分支名</span>
            <Input
              aria-label="分支名"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="feature/git-panel"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={checkout}
              onChange={(event) => setCheckout(event.target.checked)}
            />
            创建后切换到新分支
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => onCreate(branchName, checkout)} disabled={loading || !branchName.trim()}>
            创建分支
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 创建 `GitBranchBar.tsx`**

```tsx
import { GitBranch, Plus, RefreshCw } from 'lucide-react';

import type { GitRepositoryState } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DropdownMenu, DropdownMenuItem } from '../../ui/dropdown-menu';

interface GitBranchBarProps {
  state: GitRepositoryState | null;
  loading: boolean;
  mutating: boolean;
  onRefresh: () => void;
  onCheckout: (branchName: string) => void;
  onCreateBranch: () => void;
}

export function GitBranchBar({
  state,
  loading,
  mutating,
  onRefresh,
  onCheckout,
  onCreateBranch,
}: GitBranchBarProps) {
  const current = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';

  return (
    <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <DropdownMenu
          align="left"
          panelClassName="z-260 min-w-48"
          trigger={(
            <button
              type="button"
              aria-label="切换分支"
              className="flex max-w-52 items-center gap-2 truncate rounded-lg border border-border/42 bg-background/80 px-2.5 py-1.5 text-sm text-foreground/86 hover:bg-muted/45 disabled:opacity-50"
              disabled={loading || mutating || !state}
            >
              <span className="truncate">{current}</span>
            </button>
          )}
        >
          {(state?.branches ?? []).map((branch) => (
            <DropdownMenuItem
              key={branch.name}
              onClick={() => onCheckout(branch.name)}
              disabled={branch.current}
            >
              {branch.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
        {state?.hasUncommittedChanges && (
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">有未提交修改</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="新建分支"
          title="新建分支"
          onClick={onCreateBranch}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/55 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/55 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 接入 `ReviewPanel.tsx`**

在 imports 添加：

```tsx
import { GitBranchBar } from './GitBranchBar';
import { GitBranchDialog } from './GitBranchDialog';
import type { GitRepositoryState } from '../../../lib/tauri';
```

新增状态：

```tsx
const [repositoryState, setRepositoryState] = useState<GitRepositoryState | null>(null);
const [branchDialogOpen, setBranchDialogOpen] = useState(false);
const [branchError, setBranchError] = useState<string | null>(null);
```

将 `load` 中加入仓库状态读取：

```tsx
const [nextState, nextFiles] = await Promise.all([
  gitApi.getRepositoryState(projectPath),
  gitApi.getStatusChanges(projectPath, area),
]);
setRepositoryState(nextState);
setFiles(nextFiles);
```

添加 handlers：

```tsx
const checkoutBranch = useCallback(async (branchName: string) => {
  if (!projectPath) return;
  setMutatingKey(`branch:${branchName}`);
  setError(null);
  try {
    await gitApi.checkoutBranch(projectPath, branchName);
    await load();
  } catch (err) {
    setError(String(err));
  } finally {
    setMutatingKey(null);
  }
}, [load, projectPath]);

const createBranch = useCallback(async (branchName: string, checkout: boolean) => {
  if (!projectPath) return;
  setMutatingKey('branch:create');
  setBranchError(null);
  try {
    await gitApi.createBranch(projectPath, branchName, checkout);
    setBranchDialogOpen(false);
    await load();
  } catch (err) {
    setBranchError(String(err));
  } finally {
    setMutatingKey(null);
  }
}, [load, projectPath]);
```

在组件顶部渲染：

```tsx
<GitBranchBar
  state={repositoryState}
  loading={loading}
  mutating={mutatingKey != null}
  onRefresh={() => void load()}
  onCheckout={(branchName) => void checkoutBranch(branchName)}
  onCreateBranch={() => setBranchDialogOpen(true)}
/>
<GitBranchDialog
  open={branchDialogOpen}
  loading={mutatingKey === 'branch:create'}
  error={branchError}
  onOpenChange={setBranchDialogOpen}
  onCreate={(branchName, checkout) => void createBranch(branchName, checkout)}
/>
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add src/components/workspace/review/ReviewPanel.tsx src/components/workspace/review/ReviewPanel.test.tsx src/components/workspace/review/GitBranchBar.tsx src/components/workspace/review/GitBranchDialog.tsx
git commit -m "feat(ui): add git branch controls"
```

## Task 6: 还原操作 UI

**Files:**
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] **Step 1: 写失败的前端测试**

新增测试：

```tsx
it('reverts a single file after confirmation', async () => {
  render(<ReviewPanel projectPath="D:/project/app" />);

  await screen.findByText('App.tsx');
  fireEvent.click(screen.getByRole('button', { name: '还原 App.tsx' }));
  fireEvent.click(screen.getByRole('button', { name: '确认还原' }));

  await waitFor(() => expect(gitApiMock.revertStatusChanges).toHaveBeenCalledWith(
    'D:/project/app',
    'unstaged',
    'D:/project/app/src/App.tsx',
  ));
});

it('reverts all files in the current area after confirmation', async () => {
  render(<ReviewPanel projectPath="D:/project/app" />);

  await screen.findByText('App.tsx');
  fireEvent.click(screen.getByRole('button', { name: '全部还原' }));
  fireEvent.click(screen.getByRole('button', { name: '确认还原' }));

  await waitFor(() => expect(gitApiMock.revertStatusChanges).toHaveBeenCalledWith(
    'D:/project/app',
    'unstaged',
    undefined,
  ));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: FAIL，找不到“还原”按钮。

- [ ] **Step 3: 实现还原确认状态与 handler**

在 `ReviewPanel.tsx` 导入：

```tsx
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../ui/confirm-dialog';
```

新增状态：

```tsx
const [revertTarget, setRevertTarget] = useState<{ type: 'single' | 'all'; filePath?: string; name?: string } | null>(null);
```

新增 handler：

```tsx
const runRevertAction = useCallback(async () => {
  if (!projectPath || !revertTarget) return;
  const filePath = revertTarget.type === 'single' ? revertTarget.filePath : undefined;
  const key = `${area}:revert:${filePath ?? 'all'}`;
  setMutatingKey(key);
  setError(null);
  try {
    await gitApi.revertStatusChanges(projectPath, area, filePath);
    setExpandedPath(null);
    await load();
  } catch (err) {
    setError(String(err));
  } finally {
    setMutatingKey(null);
    setRevertTarget(null);
  }
}, [area, load, projectPath, revertTarget]);
```

在操作栏“全部暂存/取消暂存”旁新增：

```tsx
<button
  className="flex h-8 items-center gap-1.5 rounded-lg border border-border/42 bg-background/80 px-2.5 text-xs text-destructive transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-45"
  onClick={() => setRevertTarget({ type: 'all' })}
  disabled={loading || files.length === 0 || mutatingKey != null}
  aria-label="全部还原"
  title="全部还原"
>
  <Trash2 className="h-3.5 w-3.5" />
  <span className="hidden xl:inline">全部还原</span>
</button>
```

在文件行按钮组添加单文件还原按钮：

```tsx
<button
  type="button"
  aria-label={`还原 ${name}`}
  title="还原此文件"
  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/72 transition-colors hover:bg-background/72 hover:text-destructive"
  onClick={(event) => {
    event.stopPropagation();
    setRevertTarget({ type: 'single', filePath: file.path, name });
  }}
>
  <Trash2 className="h-3.5 w-3.5" />
</button>
```

在根节点末尾添加确认弹窗：

```tsx
<ConfirmDialog
  open={revertTarget != null}
  onOpenChange={(open) => !open && setRevertTarget(null)}
  title={revertTarget?.type === 'all' ? '还原全部修改' : `还原 ${revertTarget?.name ?? '文件'}`}
  description={area === 'unstaged'
    ? '此操作会丢弃未暂存修改，并删除未跟踪文件。'
    : '此操作会丢弃已暂存内容并还原工作区文件。'}
  confirmLabel="确认还原"
  variant="destructive"
  onConfirm={() => void runRevertAction()}
/>
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/components/workspace/review/ReviewPanel.tsx src/components/workspace/review/ReviewPanel.test.tsx
git commit -m "feat(ui): add git revert actions"
```

## Task 7: 提交区 UI 与提交信息生成

**Files:**
- Create: `src/components/workspace/review/GitCommitBox.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] **Step 1: 写失败的前端测试**

新增测试：

```tsx
it('generates a commit message into the commit input', async () => {
  gitApiMock.getStatusChanges.mockImplementation((_projectPath, area) => Promise.resolve(area === 'staged'
    ? [{
      path: 'D:/project/app/src/App.tsx',
      status: 'modified',
      originalContent: null,
      currentContent: '',
      additions: 2,
      deletions: 1,
    }]
    : []));
  gitApiMock.generateCommitMessage.mockResolvedValue({ message: 'feat: update app' });

  render(<ReviewPanel projectPath="D:/project/app" />);

  await screen.findByLabelText('提交信息');
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成提交信息' }));

  await waitFor(() => expect(screen.getByLabelText('提交信息')).toHaveValue('feat: update app'));
});

it('commits staged changes and clears the commit input', async () => {
  gitApiMock.getStatusChanges.mockImplementation((_projectPath, area) => Promise.resolve(area === 'staged'
    ? [{
      path: 'D:/project/app/src/App.tsx',
      status: 'modified',
      originalContent: null,
      currentContent: '',
      additions: 2,
      deletions: 1,
    }]
    : []));
  gitApiMock.commitChanges.mockResolvedValue('abc1234');

  render(<ReviewPanel projectPath="D:/project/app" />);

  const input = await screen.findByLabelText('提交信息');
  fireEvent.change(input, { target: { value: 'feat: update app' } });
  fireEvent.click(screen.getByRole('button', { name: '提交已暂存修改' }));

  await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
  await waitFor(() => expect(input).toHaveValue(''));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: FAIL，找不到提交信息输入框。

- [ ] **Step 3: 创建 `GitCommitBox.tsx`**

```tsx
import { Bot, GitCommitHorizontal } from 'lucide-react';

import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

interface GitCommitBoxProps {
  message: string;
  stagedCount: number;
  loading: boolean;
  generating: boolean;
  committing: boolean;
  error: string | null;
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onCommit: () => void;
}

export function GitCommitBox({
  message,
  stagedCount,
  loading,
  generating,
  committing,
  error,
  onMessageChange,
  onGenerate,
  onCommit,
}: GitCommitBoxProps) {
  const disabled = loading || stagedCount === 0;
  return (
    <div className="shrink-0 border-t border-border/25 px-4 py-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="提交信息"
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder={stagedCount > 0 ? 'feat: 描述本次修改' : '暂存修改后可提交'}
          disabled={disabled || committing}
          className="h-9 rounded-lg"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="AI 生成提交信息"
          onClick={onGenerate}
          disabled={disabled || generating || committing}
        >
          <Bot className="mr-1.5 h-3.5 w-3.5" />
          AI
        </Button>
        <Button
          type="button"
          size="sm"
          aria-label="提交已暂存修改"
          onClick={onCommit}
          disabled={disabled || committing || !message.trim()}
        >
          <GitCommitHorizontal className="mr-1.5 h-3.5 w-3.5" />
          提交
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 接入 `ReviewPanel.tsx`**

导入：

```tsx
import { GitCommitBox } from './GitCommitBox';
```

新增 staged 文件状态和提交状态：

```tsx
const [stagedFiles, setStagedFiles] = useState<GitStatusChange[]>([]);
const [commitMessage, setCommitMessage] = useState('');
const [commitError, setCommitError] = useState<string | null>(null);
```

在 `load` 中同时读取 staged 和当前 area：

```tsx
const [nextState, nextFiles, nextStagedFiles] = await Promise.all([
  gitApi.getRepositoryState(projectPath),
  gitApi.getStatusChanges(projectPath, area),
  gitApi.getStatusChanges(projectPath, 'staged'),
]);
setRepositoryState(nextState);
setFiles(nextFiles);
setStagedFiles(nextStagedFiles);
```

新增 handlers：

```tsx
const generateCommitMessage = useCallback(async () => {
  if (!projectPath) return;
  setMutatingKey('commit:generate');
  setCommitError(null);
  try {
    const suggestion = await gitApi.generateCommitMessage(projectPath);
    setCommitMessage(suggestion.message);
  } catch (err) {
    setCommitError(String(err));
  } finally {
    setMutatingKey(null);
  }
}, [projectPath]);

const commitChanges = useCallback(async () => {
  if (!projectPath || !commitMessage.trim()) return;
  setMutatingKey('commit');
  setCommitError(null);
  try {
    await gitApi.commitChanges(projectPath, commitMessage);
    setCommitMessage('');
    await load();
  } catch (err) {
    setCommitError(String(err));
  } finally {
    setMutatingKey(null);
  }
}, [commitMessage, load, projectPath]);
```

在底部统计栏上方或替代底部区域渲染：

```tsx
<GitCommitBox
  message={commitMessage}
  stagedCount={stagedFiles.length}
  loading={loading}
  generating={mutatingKey === 'commit:generate'}
  committing={mutatingKey === 'commit'}
  error={commitError}
  onMessageChange={setCommitMessage}
  onGenerate={() => void generateCommitMessage()}
  onCommit={() => void commitChanges()}
/>
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```powershell
npx vitest run src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/components/workspace/review/ReviewPanel.tsx src/components/workspace/review/ReviewPanel.test.tsx src/components/workspace/review/GitCommitBox.tsx
git commit -m "feat(ui): add git commit box"
```

## Task 8: 全量验证与修正

**Files:**
- Modify as needed: files touched in Tasks 1-7

- [ ] **Step 1: 运行前端相关测试**

Run:

```powershell
npx vitest run src/lib/tauri.test.ts src/components/workspace/review/ReviewPanel.test.tsx
```

Expected: PASS。

- [ ] **Step 2: 运行 Rust 相关测试**

Run:

```powershell
cd src-tauri
cargo test git_
```

Expected: Git 相关测试 PASS。

- [ ] **Step 3: 运行类型检查和构建**

Run:

```powershell
npm run build
```

Expected: TypeScript 和 Vite build PASS。

- [ ] **Step 4: 运行 Rust 格式与编译检查**

Run:

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo check --all-targets --all-features
```

Expected: 两个命令 PASS。

- [ ] **Step 5: 手动验证 Tauri 开发模式**

Run:

```powershell
npm run tauri dev
```

Manual expected:

- 打开任意项目的右侧审查标签。
- 顶部显示当前分支。
- 点击新建分支，输入 `feature/manual-git-panel`，创建后切换成功。
- 修改一个文件后，未暂存区显示文件。
- 单文件还原弹出确认，确认后文件从列表消失。
- 再修改文件并暂存，提交区启用。
- 点击 AI 生成后输入框填入一条提交信息。
- 点击提交后 staged 列表清空，仓库状态刷新。

- [ ] **Step 6: 最终提交**

如果 Task 8 有修正：

```powershell
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs src/lib/tauri.ts src/lib/tauri.test.ts src/components/workspace/review
git commit -m "fix(git): polish branch management workflow"
```

如果没有修正，跳过提交。

## 自检记录

- Spec 覆盖：分支查看、创建、切换、还原、提交、AI 提交信息、错误处理和测试计划均有对应任务。
- 范围控制：未加入 push/pull、merge/rebase、stash、分支图或提交历史。
- 类型一致性：后端使用 `current_branch`，前端通过 serde camelCase 使用 `currentBranch`；`gitApi` 方法名与测试和 UI 调用一致。
- 执行注意：当前工作区可能已有用户未提交改动。实施时每个任务提交前只暂存本任务涉及文件，避免混入无关改动。
