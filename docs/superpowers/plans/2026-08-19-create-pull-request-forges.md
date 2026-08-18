# 跨平台创建 Pull Request 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CodeMUX 中实现从 PR 标题/正文生成到推送当前分支、调用 GitHub/GitLab/Gitee 创建 Pull Request 并返回 URL 的完整流程。

**Architecture:** 保留现有 Git 命令作为本地仓库操作模块，新增一个以 `create_pull_request` 为唯一外部接口的 Forge 模块。Forge 模块负责校验、补全内容、推送和幂等创建；GitHub、GitLab、Gitee 只作为内部 Adapter，不让 React 或 Tauri 调用方感知平台差异。第一版不自动提交未提交改动，工作区不干净时阻止创建，避免把未提交文件误认为 PR 内容。

**Tech Stack:** React 18, TypeScript, Zustand, Tauri 2 RPC, Rust 2021, `git` CLI, `reqwest`, GitHub `gh`, GitLab `glab`, Gitee REST API, Vitest, Testing Library, Rust unit tests。

---

## 设计约束

### 外部接口

前端只调用一个创建接口：

```ts
type CreatePullRequestRequest = {
  projectPath: string;
  title: string;
  body: string;
  base: string;
};

type CreatePullRequestResult = {
  platform: 'github' | 'gitlab' | 'gitee';
  url: string;
  number: number;
  head: string;
  base: string;
};
```

后端读取 `head`，不信任前端传入的 head 分支。`base` 由弹窗中的目标分支选择传入；为空时由后端按远程默认分支、`main`、`master` 顺序解析。

### 固定执行顺序

```text
校验仓库与分支
  → 检查工作区干净
  → 补全空标题/正文
  → 解析 Forge 与仓库信息
  → 检查是否已有相同 head/base 的开放 PR
  → 非强制推送 head
  → 调用 Forge 创建 PR
  → 返回 URL 和编号
```

- 用户填写的非空标题和正文必须原样保留。
- 当前分支为基准分支、`detached HEAD`、没有相对 base 的新提交时，创建前直接返回明确错误。
- 推送只能使用普通 `git push` 或首次推送时的 `git push -u origin <head>`，禁止 `--force`。
- 创建前查询同一 `head + base` 的开放 PR，已有则直接返回已有 PR，避免重试产生重复 PR。
- 第一版不自动执行 `git commit`；存在 staged 或 unstaged 改动时，提示用户先完成提交。

### 平台与凭据

- GitHub：识别 `github.com` remote，使用已登录的 `gh` CLI 调用 REST API。
- GitLab：识别 `gitlab.com` 或 GitLab 自托管 remote，使用已登录的 `glab` CLI；无法识别自托管实例时返回可操作错误。
- Gitee：识别 `gitee.com` remote，使用 Gitee v5 REST API：
  `POST /api/v5/repos/{owner}/{repo}/pulls`。
- GitHub/GitLab 凭据由各自 CLI 管理，不把 token 传给前端。
- Gitee token 使用操作系统凭据存储；设置页面只显示“已配置/未配置”，不回显 token。

## 文件地图

- Create: `src-tauri/src/forge/mod.rs` — Forge 统一接口、流程编排、平台检测和公共类型。
- Create: `src-tauri/src/forge/github.rs` — GitHub CLI/REST Adapter。
- Create: `src-tauri/src/forge/gitlab.rs` — GitLab CLI Adapter。
- Create: `src-tauri/src/forge/gitee.rs` — Gitee REST Adapter。
- Create: `src-tauri/src/commands/forge.rs` — Tauri `create_pull_request` 与 Gitee 凭据命令。
- Modify: `src-tauri/src/commands/mod.rs` — 注册 Forge Tauri 命令模块。
- Modify: `src-tauri/src/lib.rs` — 注册新命令和 Forge 模块。
- Modify: `src-tauri/src/commands/git.rs` — 提供远程解析、工作区检查、base/head 解析和安全推送的内部函数。
- Modify: `src-tauri/src/config/types.rs` — 增加非敏感 Forge 配置状态。
- Modify: `src-tauri/src/commands/provider.rs` — 增加 Gitee token 的安全存取命令。
- Modify: `src-tauri/Cargo.toml` — 添加操作系统凭据存储依赖。
- Modify: `src/lib/tauri.ts` — 增加前端请求/结果类型和 RPC 封装。
- Modify: `src/components/workspace/review/GitPullRequestPopover.tsx` — 增加 base 分支选择、创建 PR 按钮、进度与结果状态。
- Modify: `src/components/workspace/review/GitBranchBar.tsx` — 传递分支列表和创建回调，移除仅生成流程的耦合。
- Modify: `src/components/workspace/review/ReviewPanel.tsx` — 连接创建 PR RPC 和结果刷新。
- Modify: `src/components/settings/GitSettings.tsx` — 增加 Gitee token 配置入口。
- Test: `src-tauri/src/forge/mod.rs` — 流程、平台检测、幂等和错误测试。
- Test: `src-tauri/src/forge/github.rs`、`gitlab.rs`、`gitee.rs` — Adapter 请求/响应解析测试。
- Test: `src-tauri/src/commands/git.rs` — 工作区、base/head 和推送行为测试。
- Test: `src/components/workspace/review/ReviewPanel.test.tsx` — 创建 PR 的手动触发、成功、失败和重试测试。
- Test: `src/components/settings/GitSettings.test.tsx` — Gitee token 配置状态测试。

### Task 1: 固化 Forge 领域类型和错误模型

**Files:**
- Create: `src-tauri/src/forge/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/forge/mod.rs`

- [ ] 定义 `ForgePlatform`、`RepositoryInfo`、`CreatePullRequestRequest`、`CreatePullRequestResult` 和 `ForgeError`，其中错误至少区分仓库校验、认证失败、推送失败、重复 PR、平台不支持和远程 API 错误。
- [ ] 定义内部 Adapter 接口，使调用方只需要传入仓库信息、head、base、title 和 body：

```rust
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
    ) -> Result<CreatePullRequestResult, ForgeError>;
}
```

- [ ] 为平台检测、remote URL 解析、`owner/repository` 提取和相同 head/base 判定编写纯单元测试。
- [ ] 运行 `cd src-tauri && cargo test forge::`，确认类型和测试先失败后通过。

### Task 2: 完善本地 Git 准备与安全推送

**Files:**
- Modify: `src-tauri/src/commands/git.rs`
- Test: `src-tauri/src/commands/git.rs`

- [ ] 增加读取当前 head、工作区是否干净、远程 URL、远程默认分支和相对 base 新提交数量的内部函数。
- [ ] 将现有推送逻辑抽成可复用的安全推送函数：有 upstream 时执行普通 `git push`，无 upstream 时执行 `git push -u <remote> <head>`，默认 remote 为解析出的主 remote 而不是无条件写死 `origin`。
- [ ] 在推送前拒绝 staged/unstaged 改动、detached HEAD、head 等于 base 和没有新提交的情况。
- [ ] 使用临时 Git 仓库和 bare remote 覆盖首次推送、重复推送、脏工作区、无 upstream 和 detached HEAD。
- [ ] 运行 `cd src-tauri && cargo test commands::git::`，确认已有提交、推送和仓库状态测试不回归。

### Task 3: 实现 GitHub、GitLab、Gitee Adapter

**Files:**
- Create: `src-tauri/src/forge/github.rs`
- Create: `src-tauri/src/forge/gitlab.rs`
- Create: `src-tauri/src/forge/gitee.rs`
- Modify: `src-tauri/src/forge/mod.rs`
- Test: 上述三个 Adapter 文件

- [ ] GitHub Adapter 调用 `gh api`，将 title、body、head、base 映射到 `/repos/{owner}/{repo}/pulls`，并支持查询开放 PR。
- [ ] GitLab Adapter 调用 `glab`，将 head/base 映射到 merge request 的 source/target branch，并解析返回的 URL 和 IID。
- [ ] Gitee Adapter 使用 `reqwest` 调用 `/api/v5/repos/{owner}/{repo}/pulls`，请求体包含 title、body、head、base，解析返回的 `html_url` 和 PR 编号。
- [ ] 所有 Adapter 都将认证失败、命令未安装、非零退出、HTTP 非 2xx 和响应 JSON 缺字段转换为统一 `ForgeError`。
- [ ] 通过可注入的命令执行器和 HTTP transport 编写离线测试，覆盖成功、已有 PR、401/403、仓库不存在和重复创建。
- [ ] 运行 `cd src-tauri && cargo test forge::`，确认三种平台 Adapter 测试通过。

### Task 4: 增加 Gitee 凭据安全存储

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/config/types.rs`
- Modify: `src-tauri/src/commands/provider.rs`
- Modify: `src-tauri/src/commands/forge.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/settings/GitSettings.tsx`
- Test: `src/components/settings/GitSettings.test.tsx`

- [ ] 通过操作系统凭据存储保存 Gitee token；配置文件只保存 `gitee_token_configured: boolean`，不保存 token 明文。
- [ ] 增加 `get_gitee_credential_status`、`set_gitee_token` 和 `clear_gitee_token` 命令，写入日志时只记录平台和配置状态，不记录 token。
- [ ] 设置页增加 Gitee Personal Access Token 输入、保存、清除和已配置状态；输入框使用密码类型，不回显已有值。
- [ ] 测试前端只展示状态、不显示 token，并验证保存和清除命令参数。
- [ ] 运行 `npx vitest run src/components/settings/GitSettings.test.tsx` 和 `cd src-tauri && cargo test commands::provider::`。

### Task 5: 增加创建 PR RPC 和完整后端编排

**Files:**
- Create: `src-tauri/src/commands/forge.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/forge/mod.rs`
- Modify: `src/lib/tauri.ts`
- Test: `src-tauri/src/forge/mod.rs`

- [ ] 实现 `create_pull_request` Tauri 命令，接收项目目录、标题、正文和 base。
- [ ] 按固定顺序执行仓库校验、标题/正文补全、Forge 识别、重复 PR 查询、安全推送和创建请求。
- [ ] 标题为空时优先使用最近一次提交标题；正文为空时使用提交列表和 diff 生成默认正文，再在存在 AI 配置时调用现有 PR 描述生成逻辑补全。
- [ ] 保留用户填写的非空标题/正文，不允许自动生成覆盖用户内容。
- [ ] 创建前后返回明确阶段错误，成功只返回 PR URL、编号、平台、head 和 base。
- [ ] 测试“推送失败不创建 PR”“已有 PR 不重复创建”“创建失败可重试”“非空字段不被覆盖”和“成功返回 URL/编号”。
- [ ] 运行 `cd src-tauri && cargo test forge::`，再运行 `npm run build` 验证 TypeScript RPC 类型。

### Task 6: 调整 PR 弹窗为手动生成和创建流程

**Files:**
- Modify: `src/components/workspace/review/GitPullRequestPopover.tsx`
- Modify: `src/components/workspace/review/GitBranchBar.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/lib/tauri.ts`
- Test: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] 保持“打开弹窗不自动生成”；只有点击“AI 生成”时调用现有生成 RPC。
- [ ] 增加 base 分支选择，默认使用后端解析结果或本地 `main/master`，并将选择值传给创建 RPC。
- [ ] 生成后保留可编辑标题和正文，新增“创建 PR”按钮；标题或正文为空时禁用创建。
- [ ] 创建过程中按阶段显示“检查仓库”“推送分支”“创建 PR”，禁用重复点击；失败后保留编辑内容并允许重试。
- [ ] 创建成功后显示平台、PR 编号和可点击 URL，同时保留“复制”按钮。
- [ ] 添加测试：打开不调用生成、手动生成、空字段禁用创建、创建成功展示 URL、推送失败展示错误、重试不会重复提交。
- [ ] 运行 `npx vitest run src/components/workspace/review/ReviewPanel.test.tsx`。

### Task 7: 文档、验证和交付检查

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Test: `src-tauri/src/forge/**/*.rs`
- Test: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] 在 README 中说明支持 GitHub/GitLab/Gitee、CLI 登录要求、Gitee token 配置、工作区必须干净、创建顺序和失败重试行为。
- [ ] 在 SECURITY.md 中说明 token 使用操作系统凭据存储、不会进入前端日志和不会写入普通配置文件。
- [ ] 运行受影响 Vitest 测试、完整根目录 Vitest、sidecar Vitest、`npm run build`。
- [ ] 运行 `cd src-tauri && cargo fmt --all -- --check`、`cargo test` 和 `cargo check --all-targets --all-features`。
- [ ] 手动验证 GitHub、GitLab、Gitee 各一个成功创建场景，以及推送失败、无凭据、无新提交、重复创建和 API 错误场景。

## 实施前需要确认的默认行为

1. 第一版是否按计划要求“工作区有未提交改动时阻止创建”，不自动 commit？
2. GitHub 是否使用本机 `gh` 登录，GitLab 是否使用本机 `glab` 登录，Gitee 是否在设置中配置 Personal Access Token？
3. base 分支是否允许在 PR 弹窗中选择，默认由后端优先使用远程默认分支？
4. 三个平台是否首期一起实现，还是先实现 GitHub + Gitee，再补 GitLab？
