# Claude Code 供应商配置实现计划

> **供智能体执行：** 必须使用 subagent-driven-development 或 executing-plans 逐任务执行。本计划使用复选框跟踪进度。

**目标：** 将 Claude Code 供应商改为可编辑的完整 settings.json 配置、四角色模型映射和可恢复的默认供应商切换。

**架构：** 前端通过独立纯函数在表单草稿和 Claude settings.json JSON 之间双向映射。Rust 将 Claude 专用字段保存为完整 JSON，并把默认供应商建模为稳定会话标识；原生文件操作封装为备份、递归合并、恢复的事务，供应商编辑不再触碰原生文件。

**技术栈：** React、TypeScript、Vitest、Tauri 2、Rust、serde_json。

---

## 文件结构

- 新建 src/lib/claudeSettingsConfig.ts：表单映射、JSON 校验、[1M] 编解码和默认 JSON。
- 新建 src/lib/claudeSettingsConfig.test.ts：纯函数双向映射和非法输入测试。
- 修改 src/types/provider.ts：Claude 完整 JSON、模型映射和默认供应商前端类型。
- 修改 src/components/settings/ProviderConfig.tsx：Claude 专用表单、术语替换和默认供应商固定卡片。
- 修改 src/components/agent/NewSessionPanel.tsx、src/components/agent/AgentPanel.tsx、src/lib/agentProfileSelector.ts：默认供应商的会话和发送框行为。
- 修改 src/stores/settingsStore.ts、src/lib/tauri.ts：调用 Claude 默认供应商切换命令。
- 修改 src-tauri/src/provider_profiles/types.rs：Claude 配置结构、默认选择状态和迁移。
- 修改 src-tauri/src/provider_profiles/native_config.rs：递归 JSON 合并。
- 修改 src-tauri/src/provider_profiles/service.rs：settings.json.bak 的原子备份、恢复和回滚。
- 修改 src-tauri/src/commands/provider.rs：保存与激活分离、真实 Claude JSON 回传、默认供应商切换。
- 修改 src-tauri/src/agent/commands.rs：默认 Claude 直接使用本机 settings.json。
- 修改 docs/agent-provider-profiles-guide.md：中文用户说明。

### 任务 1：建立 Claude JSON 与表单映射

**文件：**
- 新建：src/lib/claudeSettingsConfig.ts
- 测试：src/lib/claudeSettingsConfig.test.ts

- [ ] **步骤 1：编写失败的映射测试。**

~~~ts
it('将四角色表单同步到 env，并只给三个角色添加 1M 后缀', () => {
  const settings = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, {
    apiKey: 'token', baseUrl: 'https://api.example/anthropic', fallbackModel: 'fallback',
    sonnet: { displayName: 'sonnet-name', requestModel: 'sonnet', supports1m: true },
    opus: { displayName: 'opus-name', requestModel: 'opus', supports1m: false },
    fable: { displayName: 'fable-name', requestModel: 'fable', supports1m: true },
    haiku: { displayName: 'haiku-name', requestModel: 'haiku' },
  });
  expect(settings.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus', ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable[1M]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
  });
});

it('解析 JSON 时剥离 1M 后缀并保留未知字段', () => {
  const parsed = parseClaudeSettingsDraft('{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"opus[1M]"},"custom":{"keep":true}}');
  expect(parsed.form.opus).toEqual({ displayName: '', requestModel: 'opus', supports1m: true });
  expect(parsed.settings.custom).toEqual({ keep: true });
});
~~~

- [ ] **步骤 2：运行测试并确认失败。**

运行：npx vitest run src/lib/claudeSettingsConfig.test.ts

预期：失败，提示模块尚不存在。

- [ ] **步骤 3：实现最小映射 API。**

~~~ts
export const CLAUDE_SETTINGS_DEFAULT = {
  env: {}, theme: 'auto', includeCoAuthoredBy: false, autoUpdatesChannel: 'latest',
} as const;

export function parseClaudeSettingsDraft(source: string): { settings: Record<string, unknown>; form: ClaudeSettingsForm } {
  const settings: unknown = JSON.parse(source);
  if (!isRecord(settings) || !isRecord(settings.env)) throw new Error('配置 JSON 的 env 必须为对象。');
  return { settings, form: formFromClaudeSettings(settings) };
}

export function applyClaudeFormToSettings(settings: Record<string, unknown>, form: ClaudeSettingsForm): ClaudeSettings {
  return { ...settings, env: writeManagedClaudeEnv(settings.env, form) };
}
~~~

定义 ClaudeSettings、ClaudeSettingsForm、ClaudeRoleMapping 和 stripOneMillionSuffix。只有 Sonnet、Opus、Fable 有 supports1m；Haiku 类型没有该字段。空表单值删除其受管 env 键，未知顶层字段和 env 键保留。受管键必须完整覆盖 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL、ANTHROPIC_DEFAULT_HAIKU_MODEL、ANTHROPIC_DEFAULT_SONNET_MODEL、ANTHROPIC_DEFAULT_OPUS_MODEL、ANTHROPIC_DEFAULT_FABLE_MODEL、ANTHROPIC_DEFAULT_SONNET_MODEL_NAME、ANTHROPIC_DEFAULT_OPUS_MODEL_NAME 和 ANTHROPIC_DEFAULT_FABLE_MODEL_NAME。

- [ ] **步骤 4：补齐边界测试并运行通过。**

增加默认 JSON、无效 JSON、非对象 env、空值删除、[1M] 往返和 Haiku 无 1M 的测试。

运行：npx vitest run src/lib/claudeSettingsConfig.test.ts

预期：全部通过。

- [ ] **步骤 5：提交纯函数模块。**

~~~powershell
git add src/lib/claudeSettingsConfig.ts src/lib/claudeSettingsConfig.test.ts
git commit -m "feat(provider): 添加 Claude 配置映射"
~~~

### 任务 2：扩展 Claude 供应商数据与迁移

**文件：**
- 修改：src/types/provider.ts
- 修改：src-tauri/src/provider_profiles/types.rs
- 修改：src-tauri/src/commands/provider.rs
- 测试：src-tauri/src/provider_profiles/types.rs
- 测试：src-tauri/src/commands/provider.rs

- [ ] **步骤 1：编写失败的后端数据测试。**

~~~rust
#[test]
fn migrating_claude_supplier_creates_four_model_mappings_and_selects_default() {
    let registry = migrate_legacy_providers(&[legacy_claude_provider("legacy-model", true)], Some("legacy"))
        .unwrap().unwrap();
    assert!(registry.active_profile_ids.get(&AgentKind::ClaudeCode).is_none());
    let profile = registry.profiles.iter().find(|p| p.agent_kind == AgentKind::ClaudeCode).unwrap();
    assert_eq!(profile.claude_settings()["env"]["ANTHROPIC_MODEL"], "legacy-model");
}

#[test]
fn frontend_config_returns_claude_settings_with_real_auth_token() {
    let view = redact_config_for_frontend(&config_with_claude_token("secret"));
    assert_eq!(view.agent_profile_registry.profiles[0].claude_settings()["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
}
~~~

- [ ] **步骤 2：运行定向 Rust 测试并确认失败。**

运行：cargo test provider_profiles::types::tests --lib 和 cargo test commands::provider::tests --lib

预期：失败，当前结构没有 Claude JSON 访问器且配置视图会脱敏。

- [ ] **步骤 3：实现 Claude 完整 JSON 与兼容迁移。**

在 NativeProfileConfig::ClaudeCode 中以 settings: serde_json::Value 替代独立 api_key、anthropic_base_url、context_1m、advanced_config。保留旧字段的反序列化迁移：从旧字段、默认模型和 1M 设置构造完整 settings，四角色实际模型取旧默认模型，Sonnet、Opus、Fable 的声明取旧 1M 值。

Claude Code 允许缺少 active_profile_ids[ClaudeCode]，表示默认供应商；Codex 和 OpenCode 校验不变。前端类型变为：

~~~ts
type ClaudeNativeProfileConfig = {
  type: 'claude_code';
  settings: Record<string, unknown>;
};
~~~

redact_config_for_frontend 对 Codex、OpenCode 保持脱敏，对 Claude Code 保留 settings，以满足已确认的真实令牌回显。

- [ ] **步骤 4：运行测试并确认通过。**

运行：cargo test provider_profiles::types::tests --lib 和 cargo test commands::provider::tests --lib

预期：新增迁移和读取测试通过，Codex/OpenCode 脱敏测试仍通过。

- [ ] **步骤 5：提交数据模型变更。**

~~~powershell
git add src/types/provider.ts src-tauri/src/provider_profiles/types.rs src-tauri/src/commands/provider.rs
git commit -m "refactor(provider): 持久化 Claude 完整配置"
~~~

### 任务 3：实现合并、.bak 与原子恢复

**文件：**
- 修改：src-tauri/src/provider_profiles/native_config.rs
- 修改：src-tauri/src/provider_profiles/service.rs
- 测试：src-tauri/src/provider_profiles/native_config.rs
- 测试：src-tauri/src/provider_profiles/service.rs

- [ ] **步骤 1：编写失败的合并和备份测试。**

~~~rust
#[test]
fn merges_saved_claude_settings_without_removing_current_keys() {
    let merged = merge_claude_settings_value(
        json!({"env":{"KEEP":"yes","ANTHROPIC_MODEL":"old"},"permissions":{"allow":["Read"]}}),
        json!({"env":{"ANTHROPIC_MODEL":"new"},"theme":"auto"}),
    ).unwrap();
    assert_eq!(merged["env"]["KEEP"], "yes");
    assert_eq!(merged["env"]["ANTHROPIC_MODEL"], "new");
    assert_eq!(merged["permissions"]["allow"], json!(["Read"]));
}

#[test]
fn overwrites_bak_every_time_default_is_left_and_keeps_it_after_restore() {
    let temp = tempfile::tempdir().unwrap();
    let paths = NativeConfigPaths::new(temp.path().join(".claude"), temp.path().join(".codex"), temp.path().join("opencode"));
    std::fs::create_dir_all(&paths.claude_dir).unwrap();
    let service = NativeConfigWriteService::new(paths.clone(), temp.path().join("transactions"));
    std::fs::write(paths.claude_settings_path(), "{\"theme\":\"first\"}").unwrap();
    service.backup_claude_settings().unwrap();
    std::fs::write(paths.claude_settings_path(), "{\"theme\":\"second\"}").unwrap();
    service.backup_claude_settings().unwrap();
    service.restore_claude_settings_backup().unwrap();
    assert_eq!(std::fs::read_to_string(paths.claude_settings_path()).unwrap(), "{\"theme\":\"second\"}");
    assert!(paths.claude_settings_backup_path().exists());
}
~~~

- [ ] **步骤 2：运行定向测试并确认失败。**

运行：cargo test provider_profiles::native_config::tests --lib 和 cargo test provider_profiles::service::tests --lib

预期：失败，当前没有递归合并与持久备份 API。

- [ ] **步骤 3：实现合并和文件操作。**

在 native_config.rs 增加 merge_claude_settings_value(current, supplier) -> Result<Value, String>：对象递归合并，标量、数组和类型冲突由供应商值替换，不删除当前键。

在 NativeConfigPaths 增加 claude_settings_backup_path()，返回 claude_dir.join("settings.json.bak")。在 NativeConfigWriteService 增加：

~~~rust
pub fn backup_claude_settings(&self) -> Result<ClaudeBackup, NativeConfigWriteError>;
pub fn apply_merged_claude_settings(&self, supplier: &Value) -> Result<NativeConfigWriteResult, NativeConfigWriteError>;
pub fn restore_claude_settings_backup(&self) -> Result<NativeConfigWriteResult, NativeConfigWriteError>;
~~~

备份每次覆盖 .bak；恢复从不删除 .bak；三个方法复用既有锁、临时文件、replace_target 与目录同步逻辑。.bak 缺失必须返回明确错误。

- [ ] **步骤 4：运行测试并确认通过。**

运行：cargo test provider_profiles::native_config::tests --lib 和 cargo test provider_profiles::service::tests --lib

预期：递归合并、每次覆盖备份、恢复保留备份、缺失备份错误和既有事务测试全部通过。

- [ ] **步骤 5：提交原生文件事务。**

~~~powershell
git add src-tauri/src/provider_profiles/native_config.rs src-tauri/src/provider_profiles/service.rs
git commit -m "feat(provider): 支持 Claude 默认配置切换"
~~~

### 任务 4：分离保存、切换与默认 Claude 运行时

**文件：**
- 修改：src-tauri/src/commands/provider.rs
- 修改：src-tauri/src/agent/commands.rs
- 测试：src-tauri/src/commands/provider.rs
- 测试：src-tauri/src/agent/commands.rs

- [ ] **步骤 1：编写失败的事务与运行时测试。**

~~~rust
#[test]
fn saving_inactive_claude_supplier_does_not_write_settings_file() {
    let writes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let writes_for_apply = writes.clone();
    let result = upsert_agent_profile_transaction(&mut config, inactive_claude_supplier(),
        move |_| { writes_for_apply.fetch_add(1, std::sync::atomic::Ordering::SeqCst); unreachable!() },
        |_| Ok(()), |_| Ok(()));
    assert!(result.is_ok());
    assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn activating_claude_default_restores_bak_and_clears_active_supplier_id() {
    let result = activate_default_from_saved_claude_supplier();
    assert!(result.backup_exists);
    assert!(result.claude_active_id.is_none());
}

#[test]
fn default_claude_runtime_has_no_injected_credentials_or_model() {
    let resolved = resolve_default_claude_runtime_config();
    assert_eq!(resolved.profile_id, CLAUDE_DEFAULT_SUPPLIER_ID);
    assert_eq!(resolved.api_key, None);
    assert_eq!(resolved.base_url, None);
    assert_eq!(resolved.model, None);
}
~~~

- [ ] **步骤 2：运行定向测试并确认失败。**

运行：cargo test commands::provider::tests --lib 和 cargo test agent::commands::tests --lib

预期：失败，当前保存会写原生文件，运行时要求活动供应商和模型。

- [ ] **步骤 3：实现切换命令和默认运行时。**

新增稳定常量 CLAUDE_DEFAULT_SUPPLIER_ID = "__claude_default__" 与 Tauri 命令 activate_default_claude_supplier；activate_agent_provider_profile 拒绝该保留 ID。

在同一模块增加只构造默认分支的纯函数：

~~~rust
fn resolve_default_claude_runtime_config() -> ResolvedRuntimeConfig {
    ResolvedRuntimeConfig {
        profile_id: CLAUDE_DEFAULT_SUPPLIER_ID.to_string(), api_key: None, base_url: None,
        model: None, codex_needs_proxy: None, provider: None, credential_source: None,
    }
}
~~~

upsert_agent_provider_profile 只更新应用配置。未激活 Claude 供应商的新增、编辑和删除永不写 settings.json。激活 Claude 已保存供应商时：当前无 Claude 活动 ID 则先覆盖写 .bak，随后深度合并供应商 JSON，最后才提交活动 ID。Claude 供应商之间只合并，不改 .bak。激活默认项恢复 .bak 并移除 Claude 活动 ID。每个分支通过现有配置持久化补偿机制回滚失败操作。

将 ResolvedRuntimeConfig.model 改为 Option<String>。默认 Claude 会话使用保留 ID、None 凭据、URL 和模型；build_ensure_session_command 接收这些 None，让 Claude CLI 自行读取本机配置。Codex、OpenCode 结果不变。

- [ ] **步骤 4：运行通过测试。**

运行：cargo test commands::provider::tests --lib 和 cargo test agent::commands::tests --lib

预期：默认切换、持久 .bak、编辑不写入和默认运行时测试通过，既有会话快照测试保持通过。

- [ ] **步骤 5：提交命令和运行时改动。**

~~~powershell
git add src-tauri/src/commands/provider.rs src-tauri/src/agent/commands.rs
git commit -m "feat(agent): 支持 Claude 默认供应商运行时"
~~~

### 任务 5：重构设置页与会话选择器

**文件：**
- 修改：src/components/settings/ProviderConfig.tsx
- 修改：src/components/settings/ProviderConfig.test.tsx
- 修改：src/components/agent/NewSessionPanel.tsx
- 修改：src/components/agent/AgentPanel.tsx
- 修改：src/lib/agentProfileSelector.ts
- 修改：src/stores/settingsStore.ts
- 修改：src/lib/tauri.ts
- 测试：src/components/agent/NewSessionPanel.test.tsx
- 测试：src/components/agent/AgentPanel.ensure.test.tsx

- [ ] **步骤 1：先调整并扩展失败的界面测试。**

~~~tsx
it('Claude 表单使用供应商、备注与模型映射，Haiku 不显示 1M 控件', async () => {
  render(<ProviderConfigPanel />);
  await userEvent.click(screen.getByRole('button', { name: /新建 Claude Code 供应商/i }));
  expect(screen.getByText('备注（可选）')).toBeInTheDocument();
  expect(screen.queryByText('清除已保存的 API Key')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Haiku 实际请求模型')).toBeInTheDocument();
});

it('默认 Claude 供应商允许创建会话且不显示模型选择', () => {
  render(<NewSessionPanel {...props} />);
  expect(screen.getByText('默认供应商')).toBeInTheDocument();
  expect(screen.queryByLabelText('选择模型')).not.toBeInTheDocument();
});
~~~

- [ ] **步骤 2：运行测试并确认失败。**

运行：npx vitest run src/components/settings/ProviderConfig.test.tsx src/components/agent/NewSessionPanel.test.tsx src/components/agent/AgentPanel.ensure.test.tsx

预期：失败，旧界面仍展示档案、模型列表和清除开关，默认项不存在。

- [ ] **步骤 3：实现 Claude 专用草稿与布局。**

将通用 ProfileDraft 拆为共享字段和 ClaudeSupplierDraft；后者保存 settingsText 与任务 1 的 ClaudeSettingsForm。表单 onChange 调用 applyClaudeFormToSettings；JSON 在格式化或失焦后调用 parseClaudeSettingsDraft，错误时保留原文并显示原因。

Claude 标签页：名称和备注两列；API Key 后依次是 URL、模型映射、默认兜底模型、配置 JSON。Sonnet、Opus、Fable 显示复选框，Haiku 单元格为空。Codex、OpenCode 保持原有字段。供应商列表先渲染不可编辑、不可删除、不可测试的默认卡片；点击调用 activateDefaultClaudeSupplier。所有可见“档案”改为“供应商”。

- [ ] **步骤 4：让新建与已有会话识别默认项。**

在选择器适配器生成虚拟供应商 { id: CLAUDE_DEFAULT_SUPPLIER_ID, name: '默认供应商', models: [] }。选择默认项时调用默认切换命令、允许发送、隐藏模型选择并保存保留 ID 的会话快照。非默认项继续复用现有供应商和模型选择外观。默认 Claude 不显示“请先配置供应商”提示。

- [ ] **步骤 5：运行前端定向测试并确认通过。**

运行：npx vitest run src/lib/claudeSettingsConfig.test.ts src/components/settings/ProviderConfig.test.tsx src/components/agent/NewSessionPanel.test.tsx src/components/agent/AgentPanel.ensure.test.tsx

预期：所有新增和既有测试通过。

- [ ] **步骤 6：提交前端改动。**

~~~powershell
git add src/lib/claudeSettingsConfig.ts src/lib/claudeSettingsConfig.test.ts src/components/settings/ProviderConfig.tsx src/components/settings/ProviderConfig.test.tsx src/components/agent/NewSessionPanel.tsx src/components/agent/NewSessionPanel.test.tsx src/components/agent/AgentPanel.tsx src/components/agent/AgentPanel.ensure.test.tsx src/lib/agentProfileSelector.ts src/lib/tauri.ts src/stores/settingsStore.ts src/types/provider.ts
git commit -m "feat(ui): 重构 Claude Code 供应商管理"
~~~

### 任务 6：更新说明与全量验证

**文件：**
- 修改：docs/agent-provider-profiles-guide.md
- 测试：受影响的前端、Rust 与 sidecar 测试集。

- [ ] **步骤 1：补充中文说明。**

说明默认供应商直接使用 ~/.claude/settings.json、何时覆盖保存 .bak、何时恢复但保留 .bak、供应商 JSON 的合并优先级、真实令牌回显和模型映射到环境变量的规则。

- [ ] **步骤 2：运行格式化、构建和完整测试。**

~~~powershell
npm run build
npx vitest run --exclude 'src-tauri/**'
Set-Location src-tauri; cargo fmt --all -- --check
Set-Location src-tauri; cargo clippy --all-targets --all-features -- -D warnings
Set-Location src-tauri; cargo check --all-targets --all-features
Set-Location src-tauri; cargo test --lib
Set-Location src-tauri/sidecar; npm run build
Set-Location src-tauri/sidecar; npx vitest run
~~~

预期：所有命令退出码为 0。

- [ ] **步骤 3：人工验证。**

用 npm run tauri dev 新建 Claude 供应商，验证 JSON 与表单互相同步；从默认切出检查 .bak 内容；供应商间切换检查 .bak 未变；切回默认检查原文件恢复且 .bak 保留；确认新建与已有 Claude 对话能在默认供应商下发送。

- [ ] **步骤 4：提交文档。**

~~~powershell
git add docs/agent-provider-profiles-guide.md
git commit -m "docs(provider): 说明 Claude 默认供应商"
~~~
