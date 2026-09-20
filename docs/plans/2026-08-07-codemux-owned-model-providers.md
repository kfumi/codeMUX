# CodeMUX 自维护 Model Provider 实现计划

> **For agentic workers:** 按任务顺序实现；每步完成后跑对应测试。对照 ADR：`docs/adr/0005-codemux-owned-model-providers.md` 与 `CONTEXT.md`（Model Provider / Protocol Endpoint / Active Provider）。

**Goal:** 退役 `AgentProviderProfile` 与原生配置写入；以 CodeMUX 自有 Model Provider（多协议端点）为唯一供应商真相源；对话时按智能体所需协议选取端点，将 `apiKey` / `baseUrl` 等运行时注入 SDK。

**Architecture:**

```
设置 UI（供应商列表） ──CRUD──▶ AppConfig.model_providers + active_provider_id
                                      │
会话 UI（供应商+模型） ──快照──▶ sessions.provider_id (= Model Provider id) + model
                                      │
ensure/start ──resolve──▶ 按 agent_kind 映射协议 → 选 endpoint → sidecar apiKey/baseUrl/...
                                      │
                              禁止读写 ~/.claude|~/.codex|opencode.json
```

- Claude Code → 需要 `anthropic` 端点  
- Codex / OpenCode → 需要 `openai_compatible` 端点  
- 可用性：`enabled` + 非空有效 key + 匹配协议端点 + 有可用模型  
- 旧 `agent_profile_registry` / legacy `providers`：**加载时丢弃，不迁移**

**Tech Stack:** Rust（config / commands / agent resolve）、React 设置与会话 UI、Sidecar ensure_session 凭据路径、Vitest + cargo test。

---

## File Structure（预期）

### 新建
- `src-tauri/src/model_providers/mod.rs` — 模块入口
- `src-tauri/src/model_providers/types.rs` — `ModelProvider` / `ProtocolEndpoint` / `Protocol` / 内置模板 / 可用性与协议解析
- `src-tauri/src/model_providers/builtins.rs` — 内置模板目录（Anthropic、OpenAI、DeepSeek、OpenRouter、硅基流动、智谱、OpenCode Go）
- `src/lib/modelProviders.ts` — 前端：协议映射、可用性、`resolveEndpointForAgent`、内置模板元数据（若需与 Rust 镜像）
- `src/components/settings/ModelProviderPanel.tsx`（或重写 `ProviderConfig.tsx`）— 供应商中心 UI
- 对应 `*.test.ts` / `*.test.tsx` / Rust `#[cfg(test)]`

### 重写 / 大改
- `src-tauri/src/config/types.rs` — 用 `model_providers` + `active_provider_id` 替换 `agent_profile_registry`；删除或忽略旧 `providers` / registry 字段
- `src-tauri/src/config/mod.rs` — load：丢弃 registry 与 legacy providers；save：只写新模型
- `src-tauri/src/commands/provider.rs` — 新 CRUD / test / fetch-models / set-active；删除 profile 与 default-supplier 命令
- `src-tauri/src/agent/commands.rs` — `resolve_active_runtime_config` 改绑 Model Provider
- `src/types/provider.ts` — 新类型；删 `AgentProviderProfile*`
- `src/stores/settingsStore.ts` / `src/lib/tauri.ts`
- `src/components/settings/ProviderConfig.tsx`（替换为供应商 UI）
- `src/components/agent/AgentModelSelector.tsx` / `NewSessionPanel.tsx` / `AgentPanel.tsx`
- `src/lib/agentProfileSelector.ts` → 改为 provider 选择辅助（可重命名）
- Sidecar：`index.ts`（Claude 不再依赖 `loadClaudeSettingsEnv` 补 CodeMUX 会话凭据）、相关 ensure 路径

### 删除（或抽空后删）
- `src-tauri/src/provider_profiles/native_config.rs`
- `src-tauri/src/provider_profiles/service.rs`（原生写盘 / backup / restore）
- Profile 专用类型与 `migrate_legacy_providers`（若不再需要）
- UI：默认供应商卡、按 agent 分档的档案编辑、`auth.json` / `config.toml` 高级编辑

### 顺带改绑
- `src-tauri/src/commands/git.rs` — `select_commit_message_provider` 改用 Model Provider（openai_compatible 或 anthropic 任一可用）
- `AgentTimeouts`：从 `NativeProfileConfig` 迁到 `agent_configs`（各 agent 段），ensure 时仍下发 sidecar

---

## 目标数据模型（约定）

```ts
type Protocol = 'anthropic' | 'openai_compatible';

interface ProtocolEndpoint {
  protocol: Protocol;
  base_url: string;
  api_key_override?: string | null; // 可选；默认用供应商 key
  codex_needs_proxy?: boolean | null; // openai_compatible 端点附属
  // OpenCode：provider_key / npm 等挂供应商或端点扩展字段（见 Task 1）
}

interface ProviderModel {
  id: string;
  name?: string | null;
}

interface ModelProvider {
  id: string;                 // uuid；内置实例化后仍是普通 id
  name: string;
  enabled: boolean;
  api_key: string;            // 空 = 未配置
  endpoints: ProtocolEndpoint[];
  models: ProviderModel[];
  default_model: string;
  builtin_template_id?: string | null; // 如 'deepseek'，仅元数据
  // OpenCode 注入用（可选）
  opencode_provider_key?: string | null;
  opencode_npm?: string | null;
}

interface AppConfig {
  model_providers: ModelProvider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap; // 含 timeouts，无 native profile
  // ...theme 等
  // 不再持久化：agent_profile_registry、旧 providers
}
```

**协议映射（Rust + TS 共用语义）：**

| AgentKind     | Required Protocol     |
|---------------|-----------------------|
| claude_code   | anthropic             |
| codex         | openai_compatible     |
| opencode      | openai_compatible     |
| gemini_cli 等 | 本计划不改；保持现有行为或标为不走 Model Provider |

**可用性 `isProviderUsable(provider, agentKind)`：**  
`enabled && api_key.trim() && hasEndpoint(protocol) && default_model/models 可用`  
（端点 override key 非空时可代替根 key。）

**会话：** `sessions.provider_id` = Model Provider `id`（不再是 profile id / `__claude_default__`）。

---

## Task 0: 冻结与对照

- [x] 重读 `docs/adr/0005-codemux-owned-model-providers.md` 与 `CONTEXT.md` 供应商词条
- [x] 列出将删除的 Tauri 命令清单（activate_default_*、upsert_agent_provider_profile 等）供 Task 4 对照
- [x] 确认 `AgentTimeouts` 迁入 `agent_configs` 的字段形状（三端对称或共享）

---

## Task 1: Rust 数据模型 + 内置模板 + 纯函数

**Files:**
- Create: `src-tauri/src/model_providers/{mod,types,builtins}.rs`
- Modify: `src-tauri/src/lib.rs`（`mod model_providers`）
- Modify: `src-tauri/src/config/types.rs`

- [x] **Step 1:** 定义 `Protocol` / `ProtocolEndpoint` / `ModelProvider` / `ProviderModel`；serde 与 TS 对齐（snake_case）
- [x] **Step 2:** `builtins.rs` 返回模板（预填双端点 URL 与常用模型；OpenCode Go ≠ agent OpenCode）
- [x] **Step 3:** 纯函数：`required_protocol(agent_kind)`、`select_endpoint`、`effective_api_key`、`is_provider_usable`、`validate_provider`
- [x] **Step 4:** `AppConfig` 增加 `model_providers` + 复用/澄清 `active_provider_id`；`agent_profile_registry` 与旧 `providers` 反序列化时 **忽略/丢弃**（`#[serde(default)]` + load 后 clear）
- [x] **Step 5:** `cargo test -p` / 模块内单测：双端点 DeepSeek 对 claude/codex 均 usable；缺 anthropic 时 claude 不可用；空 key 不可用；disabled 不可用

**验收：** 不依赖文件系统；内置模板 URL 可后续微调但不阻塞。

---

## Task 2: Config load/save 语义

**Files:**
- Modify: `src-tauri/src/config/mod.rs`

- [x] Load：若存在 `agent_profile_registry` 或旧 `providers` → **丢弃**，不迁移；`model_providers` 缺省 `[]`
- [x] Save：只持久化 `model_providers` / `active_provider_id`；不再写 registry
- [x] `active_provider_id` 指向不存在的 id 时视为 `null`
- [x] 测试：含旧 registry 的 fixture JSON 加载后 registry 空、providers 空；保存后再读只有新字段

**验收：** 升级用户打开应用后需重配供应商（符合 ADR）。

---

## Task 3: Timeouts 迁出 Profile

**Files:**
- Modify: `src-tauri/src/config/types.rs`（`AgentConfigMap` 各段加 `timeouts`）
- Modify: `src/types/provider.ts`
- Modify: ensure 解析处（Task 5）从 `agent_configs` 读 timeouts

- [x] 从即将删除的 `NativeProfileConfig` 去掉 timeouts 依赖
- [x] 默认值与现网一致（idle / approval / question）
- [x] 单测：resolve 时 timeouts 来自 agent_configs 而非供应商

---

## Task 4: Tauri 命令面替换

**Files:**
- Rewrite surface in: `src-tauri/src/commands/provider.rs`
- Modify: `src-tauri/src/lib.rs` invoke handler 列表
- Modify: `src/lib/tauri.ts` / `src/stores/settingsStore.ts`

**新命令（建议命名）：**

| Command | 行为 |
|---------|------|
| `upsert_model_provider` | 校验并 upsert；不写原生文件 |
| `delete_model_provider` | 删除；若为 active 则 active→其余第一个或 null |
| `set_active_model_provider` | 设全局 Active Provider（须 usable？建议：允许设未配完的，但会话发送仍拦截） |
| `set_model_provider_enabled` | 切换 `enabled` |
| `test_model_provider` | 按指定 protocol 或自动选一端点探测 |
| `fetch_model_provider_models` | `GET {base}/v1/models`（openai）或厂商文档约定；写入/返回列表 |
| `list_builtin_provider_templates` | 返回内置模板（供 UI「添加」） |
| `instantiate_builtin_provider_template` | 模板 → 新 `ModelProvider`（key 空、enabled true）并 upsert |

**删除命令：**  
`upsert_agent_provider_profile`、`activate_agent_provider_profile`、`activate_default_*_supplier`、`set_active_agent_profile_model`、`delete_agent_provider_profile`、`fetch_agent_profile_models`、`test_agent_provider_profile`，以及不再需要的旧 `update_provider`/`delete_provider`/`set_active_provider`（若完全被新命令取代）。

- [x] 注册新命令、前端 `configApi` / `settingsStore` 对齐
- [x] **禁止**调用 `NativeConfigWriteService` / `apply_native_profile_config*`
- [x] 测试：upsert/delete/active/enabled；test 与 fetch 可用 mock HTTP 或现有测试模式

---

## Task 5: Runtime resolve + 会话语义

**Files:**
- Modify: `src-tauri/src/agent/commands.rs`（`resolve_active_runtime_config`、`build_ensure_session_command`）
- Session：`provider_id` 语义改为 Model Provider id（列名可不变）

**Resolve 算法：**

1. `provider_id` = 会话 `provider_id` ?? `active_provider_id`
2. 查找 `ModelProvider`；若无 / `!is_provider_usable(provider, agent_kind)` → **错误**（或返回明确未配置，前端禁发）——**不再** `__claude_default__` / 空凭据回落
3. `endpoint = select_endpoint(provider, required_protocol(agent_kind))`
4. `api_key = effective_api_key`；`base_url = endpoint.base_url`
5. Codex：附带 `codex_needs_proxy`；OpenCode：`provider`/`credential_source=codemux` + opencode 字段
6. model = 会话 model ?? provider.default_model（须在 provider.models 内或允许自定义策略：第一版要求在列表内）
7. 若会话尚未快照 provider_id，写入 `update_session_provider`

- [x] 删除 `resolve_default_claude_runtime_config` 等「空凭据可用」路径
- [x] 重写 `agent/commands.rs` 内相关测试
- [x] Gemini 等非三端：明确不走此 resolve 或保持旧路径（写进代码注释 + 本计划 Out of Scope）

**验收：** 有可用 DeepSeek（双端点）时，同一 `provider_id` 下切 claude_code / codex 都能 resolve 出对应 URL。

---

## Task 6: 拆除原生配置模块

**Files:**
- Delete/gut: `provider_profiles/native_config.rs`、`service.rs`
- Simplify: `provider_profiles/` → 若仅剩迁移垃圾则整目录删除，类型迁入 `model_providers`
- Modify: `commands/provider.rs` 去掉一切 backup/restore/apply
- Modify: `lib.rs` AppState 若有 `provider_profile_operation_lock` 则删除

- [x] 全仓库 grep：`NativeConfigWriteService`、`settings.json.codemux.bak`、`activate_default_`、`apply_native_profile` 应为零（测试 fixture 除外并删除）
- [x] `cargo test` / `cargo clippy` 通过相关 crate

> 注：`provider_profiles/types.rs` 仍保留 `AgentProfileRegistry` 等类型供旧配置反序列化后丢弃；`migrate_legacy_providers` 已移除。旧 profile Tauri 命令以 ADR 0005 退役错误桩保留兼容调用面。

---

## Task 7: Sidecar 硬切断回落

**Files:**
- Modify: `src-tauri/sidecar/src/index.ts`（Claude `buildOptions` / 启动 env）
- 视情况：`opencodeRuntime.ts`、`codexRuntime.ts`

- [x] CodeMUX 会话路径：**必须**使用 ensure 传入的 `apiKey`/`baseUrl`；缺失则失败，不从 `~/.claude/settings.json` 补全该会话凭据
- [x] 评估 `loadClaudeSettingsEnv()`：若仅服务于 CodeMUX 托管会话则停止调用或收窄到非托管场景；加测试锁定「无 apiKey 不静默成功」
- [x] OpenCode：`credentialSource: 'codemux'` + 有 key；移除「无档案 free 默认可发」若与 ADR 冲突（OpenCode Go 改为正式 Model Provider 模板）
- [x] Sidecar vitest 更新

**验收：** 集成级或单测证明：未传 key 时 Claude/Codex/OpenCode ensure 失败或前端不可进入发送。

---

## Task 8: 前端类型与 Store

**Files:**
- Rewrite: `src/types/provider.ts`（Model Provider 类型；删 Profile 类型）
- Modify: `settingsStore.ts`、`tauri.ts`
- Modify/替换: `agentProfileSelector.ts` → `modelProviderSelector.ts`（投影给选择器：无 key 明文需求时仍可遮罩）

- [x] `getActiveProvider()` 改为读 `model_providers` + `active_provider_id`
- [x] 删除 default supplier / profile 方法
- [x] `npx vitest run src/stores/settingsStore.test.ts` 等更新通过

---

## Task 9: 设置页 UI（供应商中心）

**Files:**
- Replace: `src/components/settings/ProviderConfig.tsx`（或新面板 + SettingsDialog 改挂载）
- Update: `SettingsDialog.tsx` / 文案「供应商配置」→ 可保持或改为「模型服务」
- Tests: `ProviderConfig.test.tsx` 重写

**UI 行为（对齐 ADR + 截图心智，不必像素级抄）：**

1. 左/中：供应商列表（含搜索）+「添加」→ 内置模板或自定义  
2. 右：当前供应商 — 启用开关、API Key、协议端点（可添加 Anthropic / OpenAI 地址）、模型列表、「获取模型列表」、设 Active  
3. **无**按 Claude/Codex/OpenCode 分档 Tab  
4. **无**「使用 ~/.claude/settings.json」默认供应商卡  
5. **无**整包 `config.toml` / `auth_json` 编辑  
6. 缺端点时展示提示（例如当前无 OpenAI 端点 → Codex 不可用）

- [x] 组件测试：保存 upsert、启用开关、实例化 DeepSeek 模板出现双端点  
- [ ] 手动：`npm run tauri dev` 走通添加 DeepSeek → 填 key → 设 Active

---

## Task 10: 会话 UI — 选供应商 + 模型 + 可用性

**Files:**
- Modify: `AgentModelSelector.tsx`、`NewSessionPanel.tsx`、`AgentPanel.tsx`
- Modify: `useAgentModels`（模型来自选定 Model Provider.models）
- Update tests: `NewSessionPanel.test.tsx`、`AgentPanel.ensure.test.tsx`、`AgentModelSelector.test.tsx`

**行为：**

- 选择器可选：**供应商**（全局列表中对该 agent usable 的；不可用者置灰+原因）+ **模型**
- `hasUsableProvider` 替换 `hasUsableProfile`：无 usable → 禁发 + 引导设置
- 切换供应商：`sessionApi.updateProvider(sessionId, providerId, model)`
- 切换智能体：保持同一 `provider_id`；若新 agent 不可用 → 禁发，不自动换供应商
- 删除 `__claude_default__` / usesClaudeDefault / usesOpenCodeFree / usesCodexDefault 分支

- [x] 单测覆盖：同供应商双协议切换 agent；缺端点禁发；disabled 禁发

---

## Task 11: Git commit-message 等遗留消费者

**Files:**
- Modify: `src-tauri/src/commands/git.rs`（`select_commit_message_provider`）

- [x] 改为从 `model_providers` 选 usable 供应商（优先 active，否则第一个 openai_compatible/anthropic 按实现需要）
- [x] 无可用供应商时返回明确错误
- [x] 更新相关测试

---

## Task 12: 清理与回归

- [x] Grep 清理：`AgentProviderProfile`、`agent_profile_registry`、`activateDefault`、`native_config`、`__claude_default__`、`profile_registry_is_derived`
- [x] 前端：`npx vitest run`（至少 settings + agent panels + stores）
- [x] Sidecar：`cd src-tauri/sidecar && npx vitest run`
- [x] Rust：`cd src-tauri && cargo test --all-targets`（或至少 provider/agent/config）
- [ ] `cargo clippy --all-targets --all-features -- -D warnings`（若项目 CI 要求）
- [ ] 手动清单：
  1. 全新配置：添加 DeepSeek 模板 → 填 key → Active  
  2. Claude Code 对话成功  
  3. 同供应商切 Codex 对话成功  
  4. 去掉 OpenAI 端点 → Codex 禁发且提示  
  5. 禁用供应商 → 禁发  
  6. 确认未改动 `~/.claude/settings.json` / `~/.codex/config.toml`（对话前后 diff）

> 注：Grep 清理后仍可残留：退役错误文案中的 `AgentProviderProfile`、`AppConfig` 反序列化丢弃用的 `agent_profile_registry` / `profile_registry_is_derived` 字段、以及测试 fixture 里的 `native_config` JSON 片段。生产写盘路径已拆除。

---

## Out of Scope（本计划第一刀）

- 旧 profile → Model Provider 自动迁移  
- 空 key /「使用 CLI 登录」显式开关（ADR 允许未来做，本刀不做）  
- 协议枚举扩展（`openai_responses` 等）  
- 模型目录按端点分叉（C 方案）或展示名→多协议 model id 映射  
- 像素级复刻第三方「模型服务」UI  
- Gemini CLI 完整纳入 Model Provider（除非现有路径已强迫改动）  
- 从 MCP / Skills 配置联动供应商

---

## 风险与顺序建议

| 风险 | 缓解 |
|------|------|
| 一次性删 native 模块导致大量测试红 | Task 1–5 先双轨类型、resolve 改完再 Task 6 删除 |
| Sidecar 仍读 settings 导致「看起来没配也能聊」 | Task 7 单测锁死；手动 diff 原生文件 |
| OpenCode free / default 用户路径消失 | 用 OpenCode Go 内置模板承接；文档/UI 说明需填 key |
| `sessions.provider_id` 旧 profile id 残留 | 加载会话时若 id 不在 `model_providers` → 视为未选，回退 active 或禁发 |
| Timeouts 挂档位置变更 | Task 3 尽早做，避免 ensure 回归 |

**推荐实施顺序：** Task 0 → 1 → 2 → 3 → 4 → 5 → 7（可与 5 并行调研）→ 6 → 8 → 9 → 10 → 11 → 12。

---

## 完成定义

- [x] ADR 0005 决策均有对应代码路径，且无原生配置写入调用点  
- [x] 领域用语与 `CONTEXT.md` 一致（代码注释/UI 不称 profile 为供应商）  
- [ ] 上述自动测试 + 手动清单通过  

> 自动测试已通过（前端 / sidecar / `cargo test --lib`）。手动清单与 clippy 严格门禁仍待验收。
