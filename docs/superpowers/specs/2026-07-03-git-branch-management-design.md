# Git 分支管理与审查提交流程设计

## 背景

CodeMUX 现有右侧审查面板已经支持读取 Git 未暂存/已暂存改动、查看 diff、暂存和取消暂存。后端 `src-tauri/src/commands/git.rs` 已经封装了基础 Git 命令执行、仓库初始化、状态读取和测试用临时仓库能力。

本设计在现有审查面板上补齐本地 Git 工作流：查看当前分支、创建并检出分支、切换分支、还原未提交修改、提交已暂存内容，并支持 AI 生成提交信息。首版聚焦本地操作，不包含远端 push/pull、merge、rebase、stash、冲突解决器和分支图。

## 目标

- 用户能在项目内查看当前分支和本地分支列表。
- 用户能创建新分支并立即检出。
- 用户能在干净工作区切换到其他本地分支。
- 用户能在审查面板中还原单个或全部未提交修改。
- 用户能手动填写提交信息并提交已暂存内容。
- 用户能基于已暂存 diff 生成一条可编辑的 AI 提交信息。
- 所有会修改文件或 Git 历史的操作都有明确状态、错误提示和必要确认。

## 非目标

- 不实现远端分支、push、pull、fetch。
- 不实现 merge、rebase、cherry-pick、stash。
- 不实现提交历史列表、分支图或冲突编辑器。
- 不把 AI 提交信息生成写入聊天上下文。
- 不自动暂存未暂存文件后提交。

## 推荐方案

在现有右侧 `ReviewPanel` 上扩展 Git 工作流。

理由：

- 审查面板已经是未提交修改的主要入口，新增还原和提交不会分散用户注意力。
- 后端已有 `gitApi` 和 `commands/git.rs`，可以在同一边界内补齐命令。
- 用户先看 diff、再暂存、再提交的流程自然连贯。
- 改动范围集中，测试可沿用现有 `ReviewPanel.test.tsx` 和 Rust Git 临时仓库单测模式。

备选方案是新增独立 Git 标签页。它更适合以后做分支图和提交历史，但首版会复制现有审查能力，实施成本更高。

## 后端设计

继续由 Rust 后端执行 Git 命令，前端不直接调用 shell。新增命令放在 `src-tauri/src/commands/git.rs`，并注册到 `src-tauri/src/lib.rs`。

### 数据结构

新增 `GitRepositoryState`：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub current_branch: Option<String>,
    pub branches: Vec<GitBranch>,
    pub detached: bool,
    pub has_uncommitted_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}
```

新增 `GitCommitMessageSuggestion`：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessageSuggestion {
    pub message: String,
}
```

### 新增命令

- `get_git_repository_state(project_path: String) -> Result<GitRepositoryState, String>`
  - 使用 `git branch --format=%(refname:short)` 获取本地分支。
  - 使用 `git branch --show-current` 获取当前分支。
  - 当前分支为空且 `rev-parse --short HEAD` 成功时标记 `detached = true`。
  - 使用 `git status --porcelain=v1` 判断是否有未提交修改。

- `create_git_branch(project_path: String, branch_name: String, checkout: bool) -> Result<(), String>`
  - 校验分支名非空。
  - 使用 `git check-ref-format --branch <name>` 校验名称。
  - 使用 `git branch <name>` 创建。
  - `checkout = true` 时继续执行 `git checkout <name>`。

- `checkout_git_branch(project_path: String, branch_name: String) -> Result<(), String>`
  - 切换前检查 `git status --porcelain=v1`。
  - 如果有未提交修改，返回明确错误，要求用户先提交或还原。
  - 使用 `git checkout <name>` 切换。

- `revert_git_status_changes(project_path: String, area: GitStatusArea, file_path: Option<String>) -> Result<(), String>`
  - 未暂存单文件：
    - tracked 文件使用 `git restore --worktree -- <path>`。
    - untracked 文件从磁盘删除。
  - 未暂存全部：
    - 使用 `git restore --worktree -- .` 还原 tracked 改动。
    - 使用 `git clean -fd -- .` 删除未跟踪文件。
  - 已暂存单文件：
    - 使用 `git restore --staged --worktree -- <path>`。
  - 已暂存全部：
    - 使用 `git restore --staged --worktree -- .`。
  - 所有路径都复用现有 `path_to_repo_relative`，避免绝对路径误传。

- `commit_git_changes(project_path: String, message: String) -> Result<String, String>`
  - 校验提交信息去空白后非空。
  - 先检查 staged diff 是否为空：`git diff --cached --quiet`。
  - 若为空，返回“没有已暂存修改可提交”。
  - 使用 `git commit -m <message>`。
  - 返回提交后的短 hash。

- `generate_git_commit_message(project_path: String) -> Result<GitCommitMessageSuggestion, String>`
  - 读取 staged diff：`git diff --cached --stat` 和 `git diff --cached --unified=3 --no-ext-diff`。
  - 无 staged diff 时返回错误。
  - diff 超长时截断到固定字符数，并在提示词中说明内容已截断。
  - 复用当前供应商配置进行一次轻量文本生成，返回一条提交信息。

## AI 提交信息生成

首版采用独立轻量后端命令，不创建隐藏聊天会话，也不写入 `agentStore`。

生成提示词约束：

- 输出一条提交信息，不输出解释。
- 优先遵循项目历史中的 Conventional Commits 风格。
- 根据 diff 选择 `feat`、`fix`、`docs`、`test`、`refactor`、`chore` 等类型。
- 中文项目可输出中文描述，例如 `feat(git): 增加分支切换入口`。
- 长度控制在 72 个字符以内，必要时可以省略 scope。

供应商选择：

- 使用应用当前活跃供应商和默认模型。
- 若供应商未配置或请求失败，前端展示错误，用户仍可手动填写提交信息。
- AI 生成结果只填入输入框，用户必须手动点击提交。

## 前端设计

### API 类型

在 `src/lib/tauri.ts` 新增：

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

- `getRepositoryState(projectPath)`
- `createBranch(projectPath, branchName, checkout)`
- `checkoutBranch(projectPath, branchName)`
- `revertStatusChanges(projectPath, area, filePath?)`
- `commitChanges(projectPath, message)`
- `generateCommitMessage(projectPath)`

### 审查面板布局

`ReviewPanel` 顶部改为三段：

1. 仓库头部
   - 分支图标。
   - 当前分支名。
   - 分支下拉：列出本地分支，点击切换。
   - 新建分支按钮，打开小型对话框输入分支名。
   - 刷新按钮。

2. 改动操作栏
   - 保留“未暂存/已暂存”选择。
   - 保留“全部暂存/全部取消暂存”。
   - 新增“全部还原”按钮，根据当前区域还原对应改动。

3. 文件列表与 diff
   - 每个文件行保留展开 diff。
   - 每个文件行保留暂存/取消暂存按钮。
   - 新增单文件还原按钮。

底部提交区：

- 仅当 staged 区域有文件时启用。
- 包含提交信息输入框、AI 生成按钮、提交按钮。
- 提交成功后清空输入框并刷新仓库状态和文件列表。

### 交互细节

- 新建分支默认勾选“创建后切换”。
- 工作区有未提交修改时，切换分支按钮仍可点击，但后端会拒绝，前端展示“请先提交或还原当前修改”。
- 还原单文件使用确认对话框。
- 还原全部使用更强提示，明确说明会删除未跟踪文件或丢弃已暂存内容。
- 提交按钮只在提交信息非空且存在 staged 文件时启用。
- AI 生成按钮只在存在 staged 文件且没有正在生成时启用。
- 所有 mutation 期间禁用相关按钮，避免并发 Git 操作。

## 错误处理

- Git 不可用：展示后端错误，不隐藏审查面板。
- 非 Git 仓库：沿用现有 `ensure_git_repo` 行为初始化仓库；若初始化失败则提示错误。
- 首次提交前没有 HEAD：沿用现有 `EMPTY_TREE_HASH` 逻辑读取 diff；提交时由 Git 自身处理初始提交。
- 分支名无效：在对话框内显示错误，保留输入。
- 分支已存在：展示 Git 错误。
- 切换分支有未提交修改：展示可操作提示，不执行 checkout。
- AI 生成失败：提交输入框保留当前内容，用户可手动填写。
- 提交失败：展示 Git stderr，例如未配置 `user.name` 或 `user.email`。

## 测试计划

### Rust 单测

在 `src-tauri/src/commands/git.rs` 中用临时仓库覆盖：

- 读取仓库状态能返回当前分支和分支列表。
- 创建分支并检出后当前分支变化。
- 工作区有未提交修改时拒绝切换分支。
- 还原 tracked 未暂存修改。
- 删除 untracked 文件。
- 还原已暂存修改。
- staged diff 为空时拒绝提交。
- 提交成功返回短 hash。

AI 生成命令不在 Rust 单测中调用真实网络，测试提示词组装和 staged diff 为空错误即可；网络调用通过可注入函数或独立纯函数隔离。

### 前端单测

扩展 `src/components/workspace/review/ReviewPanel.test.tsx`：

- 加载时请求仓库状态和当前区域文件。
- 点击分支项调用 `checkoutBranch` 并刷新。
- 新建分支提交时调用 `createBranch`。
- 单文件还原需要确认，并调用 `revertStatusChanges`。
- 全部还原需要确认，并刷新列表。
- AI 生成提交信息后填入输入框。
- 提交成功后调用 `commitChanges`、清空输入框并刷新 staged/unstaged 状态。

扩展 `src/lib/tauri.test.ts`：

- 覆盖新增 `gitApi` 方法的命令名和参数映射。

## 涉及文件

- `src-tauri/src/commands/git.rs`
- `src-tauri/src/lib.rs`
- `src/lib/tauri.ts`
- `src/lib/tauri.test.ts`
- `src/components/workspace/review/ReviewPanel.tsx`
- `src/components/workspace/review/ReviewPanel.test.tsx`
- 可选新增 `src/components/workspace/review/GitBranchDialog.tsx`
- 可选新增 `src/components/workspace/review/CommitBox.tsx`

## 后续演进

首版稳定后，可以继续增加：

- stash 工作流。
- 远端 push/pull。
- 提交历史和分支图。
- merge/rebase 操作。
- 冲突文件专用视图。
