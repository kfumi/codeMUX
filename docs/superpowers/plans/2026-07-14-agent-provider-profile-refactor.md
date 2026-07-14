# 智能体专属供应商档案重构实施计划

> **面向智能体执行者：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 子技能逐任务执行。所有步骤使用复选框追踪。

**目标：** 将统一供应商池重构为 Claude Code、Codex、OpenCode 各自独立的供应商档案，并让对话启动不再由前端传递连接配置。

**架构：** Rust 保存和激活智能体专属档案，负责将受管理供应商字段合并到本机原生配置并原子写入。React 沿用现有智能体选择控件，只按当前智能体读取档案和模型；会话启动由 Rust 解析激活档案，必要时只通过后端到 sidecar 的内部 IPC 传递 SDK 所需参数。

**技术栈：** React 18、TypeScript、Zustand、Vitest、Tauri 2、Rust、Serde、TOML、Node/TypeScript sidecar。

---

## 文件结构与边界

- `src-tauri/src/config/types.rs`：应用配置的持久化类型、旧统一供应商配置反序列化和迁移入口。
- `src-tauri/src/provider_profiles/`：智能体档案的领域模型、原生配置合并/写入、模型读取、连接测试和激活事务；不依赖 React 或 Tauri command。
- `src-tauri/src/commands/provider.rs`：面向前端的档案 CRUD、激活、模型切换和连接测试命令；不直接拼装文件内容。
- `src-tauri/src/agent/commands.rs`：从 Rust 端激活档案解析运行时参数，再构造 sidecar 命令。
- `src/types/provider.ts`、`src/stores/settingsStore.ts`、`src/lib/tauri.ts`：前端档案 DTO 和仅管理场景需要的调用封装。
- `src/components/settings/provider-profiles/`：列表、Tab 容器和三个智能体专属编辑表单；不在单个组件中继续堆叠三种表单逻辑。
- `src/components/agent/assistant-ui/CodeMuxModelSelector.tsx`：保留视觉和智能体选择相关接口，仅改为读取当前智能体的档案及其模型。
- `src/App.tsx`、`src/stores/agentStore.ts`、`src/lib/agentProvider.ts`：移除前端运行时连接参数解析和透传。

### 任务 1：建立 Rust 档案类型与旧配置迁移

**文件：**

- 修改：`src-tauri/src/config/types.rs`
- 修改：`src-tauri/src/config/mod.rs`
- 创建：`src-tauri/src/provider_profiles/mod.rs`
- 创建：`src-tauri/src/provider_profiles/types.rs`
- 测试：`src-tauri/src/config/types.rs` 中的 `#[cfg(test)]` 模块

- [ ] **步骤 1：编写旧供应商迁移的失败测试。**

  ```rust
  #[test]
  fn migrates_legacy_provider_into_agent_specific_profiles() {
      let config: AppConfig = serde_json::from_value(serde_json::json!({
          "providers": [{
              "id": "legacy-deepseek", "name": "DeepSeek", "api_key": "secret",
              "anthropic_base_url": "https://anthropic.example", "openai_base_url": "https://openai.example/v1",
              "default_model": "deepseek-v4", "models": ["deepseek-v4"]
          }],
          "active_provider_id": "legacy-deepseek"
      })).unwrap();

      let migrated = config.migrate_legacy_provider_profiles();
      assert_eq!(migrated.profiles_for(AgentKind::ClaudeCode).len(), 1);
      assert_eq!(migrated.profiles_for(AgentKind::Codex).len(), 1);
      assert_eq!(migrated.profiles_for(AgentKind::OpenCode).len(), 1);
      assert_eq!(migrated.active_profile_id(AgentKind::Codex), Some("legacy-deepseek-codex"));
  }
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`cd src-tauri && cargo test config::types::tests::migrates_legacy_provider_into_agent_specific_profiles`

  预期：失败，提示 `migrate_legacy_provider_profiles` 或档案类型尚未定义。

- [ ] **步骤 3：定义带类型约束的档案载荷。**

  在 `provider_profiles/types.rs` 定义以下核心接口，避免 `Provider` 继续携带跨智能体 URL：

  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(tag = "kind", rename_all = "snake_case")]
  pub enum NativeProfileConfig {
      ClaudeCode(ClaudeCodeProfileConfig),
      Codex(CodexProfileConfig),
      OpenCode(OpenCodeProfileConfig),
  }

  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  pub struct AgentProviderProfile {
      pub id: String,
      pub agent_kind: AgentKind,
      pub name: String,
      #[serde(default)]
      pub note: String,
      #[serde(default)]
      pub models: Vec<ProfileModel>,
      pub default_model: String,
      pub native_config: NativeProfileConfig,
  }

  #[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
  pub struct AgentProfileRegistry {
      #[serde(default)]
      pub profiles: Vec<AgentProviderProfile>,
      #[serde(default)]
      pub active_profile_ids: BTreeMap<AgentKind, String>,
  }
  ```

  将 `AgentKind` 的 derive 扩展为 `PartialOrd, Ord` 以支持 `BTreeMap` 键。再将 `AgentProfileRegistry` 加入 `AppConfig`，保留旧 `providers`/`active_provider_id` 为仅迁移读取字段；实现只在存在旧字段且新档案为空时迁移，并在保存成功后清除旧字段。

- [ ] **步骤 4：重新运行迁移与反序列化测试。**

  运行：`cd src-tauri && cargo test config::types::tests`

  预期：通过迁移、空配置、缺失 `models` 的旧配置和新配置 round-trip 测试。

- [ ] **步骤 5：提交类型和迁移基础。**

  ```powershell
  git add src-tauri/src/config/types.rs src-tauri/src/config/mod.rs src-tauri/src/provider_profiles
  git commit -m "feat(config): 增加智能体供应商档案迁移"
  ```

### 任务 2：实现原生配置合并、备份与原子回滚

**文件：**

- 创建：`src-tauri/src/provider_profiles/native_config.rs`
- 创建：`src-tauri/src/provider_profiles/service.rs`
- 修改：`src-tauri/src/provider_profiles/mod.rs`
- 测试：`src-tauri/src/provider_profiles/native_config.rs` 中的 `#[cfg(test)]` 模块

- [ ] **步骤 1：编写合并保留非供应商配置的失败测试。**

  ```rust
  #[test]
  fn claude_merge_replaces_managed_env_and_keeps_mcp_servers() {
      let existing = serde_json::json!({
          "env": { "ANTHROPIC_BASE_URL": "https://old", "KEEP": "yes" },
          "mcpServers": { "filesystem": { "command": "npx" } }
      });
      let merged = merge_claude_settings(existing, &claude_profile("https://new", "key"));
      assert_eq!(merged["env"]["ANTHROPIC_BASE_URL"], "https://new");
      assert_eq!(merged["env"]["KEEP"], "yes");
      assert!(merged["mcpServers"]["filesystem"].is_object());
  }
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`cd src-tauri && cargo test provider_profiles::native_config::tests::claude_merge_replaces_managed_env_and_keeps_mcp_servers`

  预期：失败，提示合并函数尚未实现。

- [ ] **步骤 3：实现每种智能体的渲染和合并策略。**

  创建 `NativeConfigTarget` 枚举（Claude `settings.json`、Codex `auth.json/config.toml`、OpenCode `opencode.json`），并实现：

  ```rust
  pub fn render_profile_files(profile: &AgentProviderProfile, existing: &NativeFileSet)
      -> Result<Vec<PendingNativeWrite>, ProviderProfileError>;

  pub fn commit_atomically(writes: &[PendingNativeWrite])
      -> Result<(), ProviderProfileError>;
  ```

  `render_profile_files` 仅覆盖供应商专属字段，保留未知键、MCP、插件、Skills、权限和其他通用配置。`commit_atomically` 必须先将原文件备份到应用数据目录，再写同目录临时文件，全部成功才 rename；任一失败时恢复所有已替换文件。

- [ ] **步骤 4：补充 Codex 双文件和失败回滚测试。**

  ```rust
  #[test]
  fn codex_write_failure_restores_auth_and_config_files() {
      let fixture = NativeConfigFixture::with_codex_files();
      let result = fixture.fail_second_replace().activate(&codex_profile());
      assert!(result.is_err());
      assert_eq!(fixture.read_auth(), fixture.original_auth());
      assert_eq!(fixture.read_toml(), fixture.original_toml());
  }
  ```

  运行：`cd src-tauri && cargo test provider_profiles::native_config::tests`

  预期：通过保留通用配置、Codex 双文件回滚和 JSON/TOML 解析错误测试。

- [ ] **步骤 5：提交原生配置事务。**

  ```powershell
  git add src-tauri/src/provider_profiles
  git commit -m "feat(provider): 支持原生配置原子写入"
  ```

### 任务 3：提供档案 CRUD、激活、模型与测试命令

**文件：**

- 修改：`src-tauri/src/commands/provider.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/provider_profiles/service.rs`
- 测试：`src-tauri/src/commands/provider.rs` 中的 `#[cfg(test)]` 模块

- [ ] **步骤 1：先编写激活命令仅在原生写入成功后更新状态的失败测试。**

  ```rust
  #[test]
  fn activation_does_not_change_active_id_when_native_write_fails() {
      let mut config = config_with_two_claude_profiles();
      let result = activate_profile(&mut config, "claude-b", &failing_writer());
      assert!(result.is_err());
      assert_eq!(config.active_profile_id(AgentKind::ClaudeCode), Some("claude-a"));
  }
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`cd src-tauri && cargo test commands::provider::tests::activation_does_not_change_active_id_when_native_write_fails`

  预期：失败，提示新命令或服务未定义。

- [ ] **步骤 3：以智能体和档案 ID 设计 Tauri 命令。**

  用以下命令替代 `update_provider`、`delete_provider`、`set_active_provider` 和统一 `fetch_provider_models`：

  ```rust
  #[tauri::command]
  pub fn upsert_agent_provider_profile(profile: AgentProviderProfile, app: AppHandle, state: State<AppState>) -> Result<AppConfig, String>;

  #[tauri::command]
  pub fn activate_agent_provider_profile(agent_kind: AgentKind, profile_id: String, app: AppHandle, state: State<AppState>) -> Result<AppConfig, String>;

  #[tauri::command]
  pub fn set_active_profile_model(agent_kind: AgentKind, model_id: String, app: AppHandle, state: State<AppState>) -> Result<AppConfig, String>;

  #[tauri::command]
  pub async fn fetch_agent_profile_models(profile: AgentProviderProfile, app: AppHandle) -> Result<Vec<ProfileModel>, String>;
  ```

  所有命令都先调用领域服务，再保存 `AppConfig`；命令错误不得包含 API Key。将命令注册到 `src-tauri/src/lib.rs`。

- [ ] **步骤 4：为三类模型来源和错误脱敏补充测试。**

  运行：`cd src-tauri && cargo test commands::provider::tests provider_profiles::service::tests`

  预期：Claude 角色映射、Codex TOML 元数据、OpenCode 模型映射均能返回当前档案模型，错误文本不含 `secret`。

- [ ] **步骤 5：提交档案管理 API。**

  ```powershell
  git add src-tauri/src/commands/provider.rs src-tauri/src/lib.rs src-tauri/src/provider_profiles
  git commit -m "feat(provider): 增加智能体档案管理命令"
  ```

### 任务 4：将会话运行时解析下沉到 Rust

**文件：**

- 修改：`src-tauri/src/agent/commands.rs`
- 修改：`src-tauri/src/commands/session.rs`
- 修改：`src-tauri/src/agent_runtime/types.rs`
- 测试：`src-tauri/src/agent/commands.rs` 中的 `#[cfg(test)]` 模块

- [ ] **步骤 1：编写后端构造 sidecar 命令而不是接受前端连接参数的失败测试。**

  ```rust
  #[test]
  fn ensure_command_resolves_active_codex_profile_inside_rust() {
      let state = state_with_active_codex_profile("deepseek", "sk-secret", "https://api.example/v1");
      let command = build_ensure_session_command(&state, "session-1", "codex", "D:\\work".into(), None, None);
      assert_eq!(command["model"], "deepseek-v4");
      assert_eq!(command["apiKey"], "sk-secret");
      assert!(!command.to_string().contains("providerId"));
  }
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`cd src-tauri && cargo test agent::commands::tests::ensure_command_resolves_active_codex_profile_inside_rust`

  预期：失败，旧 `build_ensure_session_command` 仍要求 API Key、URL、模型等前端参数。

- [ ] **步骤 3：收缩公开命令参数并建立内部解析器。**

  将 `ensure_agent_session` 和 `start_agent_session` 的公开参数收缩为会话 ID、工作目录、channel、输入、权限与计划模式。新增：

  ```rust
  fn resolve_active_runtime_config(state: &AppState, session_id: &str)
      -> Result<ResolvedRuntimeConfig, String>;
  ```

  该函数通过 session 的 `agent_kind` 读取激活档案、默认模型并更新会话快照。`ResolvedRuntimeConfig` 仅用于 Rust 到 sidecar 的命令构造；日志的 `Debug` 输出只显示密钥是否存在。

- [ ] **步骤 4：验证会话快照与运行中会话不重配。**

  ```rust
  #[test]
  fn running_session_keeps_its_snapshot_after_global_profile_switch() {
      let mut state = state_with_active_claude_profile("claude-a");
      let first = resolve_active_runtime_config(&state, "session-1").unwrap();
      activate_profile_in_state(&mut state, "claude-b");
      assert_eq!(first.profile_id, "claude-a");
  }
  ```

  运行：`cd src-tauri && cargo test agent::commands::tests`

  预期：通过内部解析、会话快照和脱敏日志测试。

- [ ] **步骤 5：提交运行时边界改造。**

  ```powershell
  git add src-tauri/src/agent/commands.rs src-tauri/src/commands/session.rs src-tauri/src/agent_runtime/types.rs
  git commit -m "refactor(agent): 后端解析智能体供应商档案"
  ```

### 任务 5：收缩前端 Tauri 调用与状态模型

**文件：**

- 修改：`src/types/provider.ts`
- 修改：`src/lib/tauri.ts`
- 修改：`src/stores/settingsStore.ts`
- 修改：`src/lib/agentProvider.ts`
- 修改：`src/lib/agentProvider.test.ts`
- 修改：`src/App.tsx`
- 修改：`src/stores/agentStore.ts`

- [ ] **步骤 1：为前端启动命令无连接参数编写失败测试。**

  ```ts
  it('启动会话时不向 Tauri 传递供应商连接参数', async () => {
    await agentApi.startSession('session-1', '你好', 'D:/work', onEvent);
    expect(invoke).toHaveBeenCalledWith('start_agent_session', expect.not.objectContaining({
      apiKey: expect.anything(), baseUrl: expect.anything(), provider: expect.anything(), codexNeedsProxy: expect.anything(),
    }));
  });
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`npx vitest run src/lib/tauri.test.ts src/lib/agentProvider.test.ts`

  预期：失败，现有封装和 `resolveAgentProviderConfig` 仍返回并传递运行时连接参数。

- [ ] **步骤 3：替换 DTO 和调用签名。**

  在 `provider.ts` 定义前端 `AgentProviderProfile`、`ProfileModel`、`AgentProfileRegistry` DTO；在 store 中提供 `profilesForAgent`、`activeProfileForAgent`、`activateProfile`、`setActiveProfileModel`。从 `agentApi.ensureSession`/`startSession`、`useAgentStore.startQuery` 和 `App.handleStartNewSession` 删除 `apiKey`、`baseUrl`、`provider`、`credentialSource`、`codexNeedsProxy` 参数。删除或缩减 `agentProvider.ts`，只保留展示档案/模型所需的纯选择器。

- [ ] **步骤 4：运行前端状态和调用测试。**

  运行：`npx vitest run src/lib/tauri.test.ts src/lib/agentProvider.test.ts src/stores/settingsStore.test.ts src/App.test.tsx`

  预期：通过档案状态、会话启动参数和现有应用启动测试。

- [ ] **步骤 5：提交前端运行时参数收缩。**

  ```powershell
  git add src/types/provider.ts src/lib/tauri.ts src/stores/settingsStore.ts src/lib/agentProvider.ts src/lib/agentProvider.test.ts src/App.tsx src/stores/agentStore.ts
  git commit -m "refactor(ui): 移除会话连接参数透传"
  ```

### 任务 6：拆分并实现智能体 Tab 供应商管理界面

**文件：**

- 修改：`src/components/settings/ProviderConfig.tsx`
- 创建：`src/components/settings/provider-profiles/AgentProfileTabs.tsx`
- 创建：`src/components/settings/provider-profiles/ProfileList.tsx`
- 创建：`src/components/settings/provider-profiles/ClaudeProfileForm.tsx`
- 创建：`src/components/settings/provider-profiles/CodexProfileForm.tsx`
- 创建：`src/components/settings/provider-profiles/OpenCodeProfileForm.tsx`
- 创建：`src/components/settings/provider-profiles/profileFormTypes.ts`
- 修改：`src/components/settings/ProviderConfig.test.tsx`
- 创建：`src/components/settings/provider-profiles/AgentProfileTabs.test.tsx`

- [ ] **步骤 1：编写 Tab 隔离和当前启用档案的失败测试。**

  ```tsx
  it('切换到 Codex Tab 时只渲染 Codex 档案和其当前启用项', async () => {
    render(<ProviderConfigPanel />, { wrapper: configWithProfiles({
      claude_code: [claudeProfile('Claude DeepSeek')],
      codex: [codexProfile('Codex DeepSeek')],
    }) });
    await userEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.getByText('Codex DeepSeek')).toBeInTheDocument();
    expect(screen.queryByText('Claude DeepSeek')).not.toBeInTheDocument();
    expect(screen.getByText('使用中')).toBeInTheDocument();
  });
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`npx vitest run src/components/settings/ProviderConfig.test.tsx src/components/settings/provider-profiles/AgentProfileTabs.test.tsx`

  预期：失败，旧页面只支持统一卡片列表。

- [ ] **步骤 3：将页面拆为 Tab、列表和三类表单。**

  `ProviderConfigPanel` 只负责路由编辑态和挂载 `AgentProfileTabs`。`ProfileList` 显示当前启用摘要、档案卡片、启用和测试操作。三个表单只接受各自的 `native_config` 类型：Claude 包含角色模型映射与 `settings.json`，Codex 包含 API 格式、`auth.json`/`config.toml`，OpenCode 包含 API 格式、SDK 选项与 `opencode.json`。所有表单只含名称和备注等需求字段，不添加官网字段。

- [ ] **步骤 4：补充保存、激活、删除、模型拉取和错误提示测试。**

  运行：`npx vitest run src/components/settings/ProviderConfig.test.tsx src/components/settings/provider-profiles`

  预期：通过 Tab 隔离、各表单独立字段、写入失败提示和无模型禁用保存测试。

- [ ] **步骤 5：提交供应商管理 UI。**

  ```powershell
  git add src/components/settings/ProviderConfig.tsx src/components/settings/provider-profiles
  git commit -m "feat(ui): 增加智能体专属供应商管理"
  ```

### 任务 7：复用智能体选择并改造供应商/模型选择器

**文件：**

- 修改：`src/components/agent/NewSessionPanel.tsx`
- 修改：`src/components/agent/assistant-ui/CodeMuxModelSelector.tsx`
- 修改：`src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx`
- 修改：`src/stores/newSessionStore.ts`

- [ ] **步骤 1：编写切换智能体后供应商和模型数据源变化的失败测试。**

  ```tsx
  it('保留既有智能体控件并按所选智能体切换档案模型', async () => {
    render(<CodeMuxModelSelector />, { wrapper: profileConfigWithClaudeAndCodex() });
    await userEvent.selectOptions(screen.getByLabelText('智能体'), 'codex');
    expect(screen.getByRole('button', { name: /Codex DeepSeek/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Codex DeepSeek/ }));
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument();
    expect(screen.queryByText('claude-sonnet')).not.toBeInTheDocument();
  });
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`npx vitest run src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx`

  预期：失败，选择器仍读取 `config.providers` 和统一 `active_provider_id`。

- [ ] **步骤 3：保持现有智能体控件，替换下游数据和副作用。**

  不改变 `NewSessionPanel` 的智能体选择位置或样式。`CodeMuxModelSelector` 使用 `selectedAgentKind` 读取该智能体的档案；供应商切换调用 `activateProfile(agentKind, profileId)`，模型切换调用 `setActiveProfileModel(agentKind, modelId)`。两个异步操作成功后再更新本地选择；失败时保持原值并显示 toast。无档案或无模型时禁用发送，并提供打开设置页的回调。

- [ ] **步骤 4：运行选择器与草稿状态测试。**

  运行：`npx vitest run src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx src/stores/newSessionStore.test.ts`

  预期：通过既有视觉行为、智能体切换联动、全局激活调用和失败回滚测试。

- [ ] **步骤 5：提交选择器改造。**

  ```powershell
  git add src/components/agent/NewSessionPanel.tsx src/components/agent/assistant-ui/CodeMuxModelSelector.tsx src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx src/stores/newSessionStore.ts
  git commit -m "feat(chat): 按智能体切换供应商和模型"
  ```

### 任务 8：调整 sidecar 配置消费与回归测试

**文件：**

- 修改：`src-tauri/sidecar/src/index.ts`
- 修改：`src-tauri/sidecar/src/codexRuntime.ts`
- 修改：`src-tauri/sidecar/src/opencodeRuntime.ts`
- 测试：`src-tauri/sidecar/src/codexRuntime.test.ts`（新建或扩展现有相邻测试文件）
- 测试：`src-tauri/sidecar/src/opencodeRuntime.test.ts`（新建或扩展现有相邻测试文件）

- [ ] **步骤 1：编写由内部 Rust 命令提供运行时配置的 sidecar 测试。**

  ```ts
  it('只接受内部 ensure 命令提供的 Codex 运行时配置', async () => {
    const runtime = new CodexSessionRuntime();
    await runtime.ensure({ type: 'ensure_session', sessionId: 's1', agentKind: 'codex', cwd: 'D:/work', model: 'gpt-5' });
    expect(mockCodex).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: undefined, apiKey: undefined }));
  });
  ```

- [ ] **步骤 2：运行失败测试。**

  运行：`cd src-tauri/sidecar && npx vitest run src/codexRuntime.test.ts src/opencodeRuntime.test.ts`

  预期：失败或缺少测试文件，现有 bootstrap 对前端动态连接字段有隐式依赖。

- [ ] **步骤 3：保持内部兼容字段，移除前端来源假设。**

  保留 sidecar 的 `apiKey`、`baseUrl` 等字段作为受信任的 Rust 内部 IPC 载荷，删除任何将其视为浏览器请求参数的分支和日志。Codex 兼容代理的 fingerprint 由内部已激活档案生成；OpenCode 的 `provider`、`model`、凭据来源同样从 Rust 解析结果生成。所有日志只输出配置是否存在，不输出值。

- [ ] **步骤 4：运行 sidecar 完整测试。**

  运行：`cd src-tauri/sidecar && npx vitest run`

  预期：通过 Codex 代理、OpenCode 启动、无敏感日志和默认模型测试。

- [ ] **步骤 5：提交 sidecar 兼容改造。**

  ```powershell
  git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/codexRuntime.ts src-tauri/sidecar/src/opencodeRuntime.ts src-tauri/sidecar/src/*.test.ts
  git commit -m "refactor(sidecar): 使用后端解析的智能体配置"
  ```

### 任务 9：端到端验证、迁移提示与文档

**文件：**

- 修改：`src/components/settings/ProviderConfig.test.tsx`
- 修改：`src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx`
- 修改：`src/App.test.tsx`
- 创建：`docs/agent-provider-profiles-guide.md`
- 修改：`README.md`（仅在设置入口需要说明时）

- [ ] **步骤 1：编写跨层回归测试。**

  ```tsx
  it('迁移后新建 Codex 对话只使用激活档案且前端调用没有连接字段', async () => {
    mockConfigApi.get.mockResolvedValue(migratedProfileConfig);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /新建对话/ }));
    await userEvent.selectOptions(screen.getByLabelText('智能体'), 'codex');
    await userEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(mockInvoke).toHaveBeenCalledWith('start_agent_session', expect.not.objectContaining({ apiKey: expect.anything(), baseUrl: expect.anything() }));
  });
  ```

- [ ] **步骤 2：运行跨层失败测试。**

  运行：`npx vitest run src/App.test.tsx src/components/settings/ProviderConfig.test.tsx src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx`

  预期：在实现缺失或参数仍泄漏时失败。

- [ ] **步骤 3：补充迁移提示和中文使用文档。**

  在设置页迁移完成后显示“已创建智能体专属档案；需检查的高级配置请在对应 Tab 确认”。在 `docs/agent-provider-profiles-guide.md` 说明三个 Tab 的原生配置文件、全局切换只影响新会话、备份与回滚行为、以及如何处理“需检查”档案。

- [ ] **步骤 4：执行完整验证。**

  运行：

  ```powershell
  npm run build
  npx vitest run
  Set-Location src-tauri; cargo fmt --all -- --check; cargo clippy --all-targets --all-features -- -D warnings; cargo check --all-targets --all-features
  Set-Location sidecar; npm run build; npx vitest run
  ```

  预期：全部通过；手动在 `npm run tauri dev` 中验证三个 Tab、激活/回滚、智能体切换和新会话不会透传连接参数。

- [ ] **步骤 5：提交验证与文档。**

  ```powershell
  git add src/App.test.tsx src/components/settings/ProviderConfig.test.tsx src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx docs/agent-provider-profiles-guide.md README.md
  git commit -m "docs(provider): 补充智能体档案使用说明"
  ```
