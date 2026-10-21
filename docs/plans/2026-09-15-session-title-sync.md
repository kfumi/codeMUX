# 会话标题自动同步（底层标题 → CodeMUX）

> 2026-10-21 更新：Claude 标题链路在实测中改了两处前提，本文已按实现更新。
> （1）headless/SDK 模式下 CLI **不会**自动生成 `ai-title`，必须由宿主调用
> `query.generateSessionTitle(text, { persist: true })`；（2）`getSessionInfo`
> 是 SDK 的**模块级导出**，不是 `Query` 实例方法。另补入「Claude 上下文/压缩
> 环境变量防护」，防止外部 settings.json 反向限制 CodeMUX 的模型上下文。

## 目标与原则（已与用户确认）

- **不自建 LLM 标题生成**：标题优先采用底层 runtime 自己产出的（OpenCode 事件推送、Claude ai-title、Codex/pi 的 name——有则用），没有原生标题的（Codex/pi 现状）维持现有"首条用户消息截断"兜底。
  - 例外：Claude headless 不自动产出 ai-title，因此由宿主**请求 CLI 自己**跑标题模型（`generateSessionTitle`），仍然不新造请求、不解析模型输出。
- **不回写底层 runtime**：不改 Claude `renameSession`、Codex `thread/name/set`、pi `set_session_name`。Claude 的 `persist: true` 属于 CLI 自己写自己的 transcript，不算宿主回写。
- **用户手动改名后锁定**（参考 codeg 的 `title_locked` 语义），原生标题不再覆盖。
- 现有"首条消息播种"保留：前端 `agentStore.ts:2716` 的自动标题作为播种，原生标题晚到时替换它（未加锁时）。

## 统一协议：新增 sidecar 控制信封 `agent_session_title`

```json
{ "type": "agent_session_title", "app_session_id": "...", "agent_kind": "opencode",
  "title": "...", "runtime_generation": 1 }
```

非 timeline 控制事件，与 `agent_session_mapping` 同类：不进 `isCodeMuxDomainEvent` / `CODE_MUX_DOMAIN_EVENT_TYPES`，不落 timeline。

## 一、Sidecar（apps/sidecar/src/）

### 1. OpenCode（推送式，白捡）
- `opencodeEvents.ts:341-343`：`session.updated` 分支从 `properties.info` 读 `title`。
- 去重与过滤：runtime 实例内记录 `lastEmittedTitle`（初始为空）；只在该 session 的 title 发生变化且非空时 emit；过滤占位标题（`/^New session - /`、`/^Child session - /`，会话刚创建时会推占位符，不能让它覆盖播种标题）。
- 通过现有 `emit()` 发 `agent_session_title` 信封（`session_id` = ctx.sessionId，含 `runtime_generation`）。

### 2. Claude（首轮 result 后生成 + 阶梯拉取）
- 触发点：`index.ts` 的 `result` 分支调用 `scheduleClaudeTitleSync(queryHandle, appSessionId, prompt)`，每 session 至多成功同步一次（`claudeTitleSynced` 标志），并用 `claudeTitleInFlight` 防止并发生成。
- **第一步（主动生成）**：`queryHandle.generateSessionTitle(firstPrompt, { persist: true })`。headless/SDK 模式不会自己生成 ai-title，必须显式请求；`persist: true` 让 CLI 把结果写进 transcript。生成有 20s 硬超时（`withClaudeTitleTimeout`），避免挂起的 promise 永久占住 `claudeTitleInFlight`。
- **第二步（兜底拉取）**：从托管 Runtime 加载的 SDK 模块上取 `getSessionInfo(sdkSessionId)`（**模块级导出**，不是 Query 方法），`extractClaudeSessionTitle` 归一化：
  - 优先 `customTitle`（用户在 CLI 里 `/rename` 的值）；
  - 其次 `summary`，但若 `summary` 只是 first prompt（含 SDK 的截断前缀形态），返回 `undefined`，表示 ai-title 尚未落盘。
- **阶梯重试**：`4s / 12s / 30s / 60s` 各拉一次（`CLAUDE_TITLE_SYNC_DELAYS_MS`），因为 CLI 在 `result` **之后**才异步写 ai-title；命中后立即置 `claudeTitleSynced` 并停止。
- **生命周期**：定时器按运行代际（`claudeTitleRunId`）归属，`resetForReconfigure()`（含 `shutdown()`）递增代际并清空所有定时器，避免上一会话的迟到读取覆盖新会话标题；`emitClaudeTitle` 还会校验 `config.sessionId` 与事件 `appSessionId` 一致。
- **升级兼容**：旧版 Runtime 无 `generateSessionTitle` / `getSessionInfo` 时静默跳过，不做最低版本强限。
- 类型声明：`providerSdkTypes.d.ts` 增 `QueryTitleGenerator`（Query 实例上的非公开方法）与模块级 `getSessionInfo`；`sdkLoader.ts` 的 `ClaudeSdkModule` 相应增可选 `getSessionInfo`。

### 3. Claude 上下文/压缩环境变量防护
- 背景：托管 Runtime 会加载用户 `~/.claude/settings.json`（`settingSources`）。外部工具写入的 `env` 块可能钉住上下文窗口：实测 Magpie 写的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000` 让 `[1m]` 会话仍在 ~239k 自动压缩（`window = min(modelWindow, configured)`）。
- 处理：`claudeModelAliasEnv.ts` 新增 `CLAUDE_CONTEXT_ENV_KEYS`（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_DISABLE_1M_CONTEXT`）与 `wipeClaudeContextEnv` / `buildClaudeContextEnvWipe`。
- 清两处：子进程 `env` 与 SDK `settings.env`（最高优先级的用户层）。空串是仓库既有的"已清除"约定（同 `ANTHROPIC_AUTH_TOKEN` / 模型别名）。对**所有** Claude 会话生效（含直连 Anthropic），保证应用内上下文配置优先于外部 settings。

### 4. Codex（首轮后探测一次）
- `codexAppServerRuntime.ts:982-1007` `turn/completed` 处：每 thread 一次性（`titleSynced` 标志）新增 `transport.request('thread/read', { threadId })`（仿 :1385 resume 的请求写法），读到 `thread.name` 非空才 emit；`name` 为空/请求失败静默跳过（Codex 现状无自动命名，纯前向兼容 + 接住 TUI 侧命名的场景）。

### 5. pi（跟随原生改名）
- `piEvents.ts:246-275` 补 `session_info_changed` case：`name` 非空时 emit `agent_session_title`。
- `piRuntime.ts:538-548` `readSessionIdentity` 已有的 `get_state` 里顺带读 `sessionName`，非空时 emit 一次。

### 6. 公共发射器
- 新建小工具（如 `sessionTitleEvent.ts`）：`buildSessionTitleEvent({ appSessionId, agentKind, title, runtimeGeneration? })`，各 runtime 复用；index.ts 的 opencode/pi mapping builder 旁边加对应 builder（照 index.ts:100-130 模式）。

## 二、Daemon（crates/daemon/src/）

### 1. Schema（db/schema.rs）
- `sessions` 表加列 `title_locked INTEGER NOT NULL DEFAULT 0`：沿用 probe-ALTER 惯用法（仿 schema.rs:324-329 的 `working_path` 探测块），插在 :329 之后。

### 2. Operations（db/operations.rs）
- `update_session_title`（:853）扩展：当调用方要求锁定时同时 `SET title_locked = 1`（手动改名 = 锁定）。
- 新增 `refresh_auto_session_title(conn, session_id, title) -> bool`：
  - 归一化：trim、取首行、80 字符截断加 `…`（对齐 `history_import.rs:1119` 的 truncate_title；把该 helper 提为可复用或等价实现）；
  - 条件 UPDATE：`UPDATE sessions SET title = ?1 WHERE id = ?2 AND title_locked = 0 AND title <> ?1`，返回是否变更；不 bump `updated_at`；锁定/未变化 → 不写。

### 3. 事件解析与处理（agent/session_lifecycle.rs）
- 新增 `AgentSessionTitleEvent` struct + `parse_agent_session_title_event`（仿 :706-760 mapping parser：校验 `type`、取 `app_session_id`/`agent_kind`/`title`/`runtime_generation`）。
- dispatch 循环（:478-551）在 mapping 处理之后、timeline fallthrough 之前挂上，命中则 `continue`（同 mapping：不进 timeline，不触发原始事件重广播路径之外的处理）。
- handler `handle_agent_session_title_event`（仿 :789-859）：信封里的 `app_session_id` 解析会话 → 校验会话存在（:808-827 同款）→ 取生命周期锁 → OpenCode 事件若带 `runtime_generation` 用 `mapping_generation_is_current`（:435）丢弃过期代际 → `refresh_auto_session_title` → 若有变更，向 companion 广播。
- 兼容 OpenCode 之外的代际缺省（claude/codex/pi 不带 generation，跳过校验）。

### 4. Companion 推送（companion/events.rs）
- 标题变更时经 `broadcast_event`（:136-142）广播会话级事件 `{"type": "session_title_changed", "title": ...}`（`CompanionBroadcastEvent.session_id` = 会话 id），走现有 per-session WS，前端无需新通道。
- 顺带修复一个缺口：手动改名路由（routes_extended.rs:93-179）目前不广播，本次让它也广播 `session_title_changed`，多端（手机/浏览器）改名能同步显示。

## 三、前端（src/）

### 1. sessionStore（src/stores/sessionStore.ts）
- 新增本地 action `applySessionTitle(sessionId, title)`：直接 patch store 的 `sessions` 与 `archivedSessions`（对齐 setSessionPinned 的双列表行为），不发请求。

### 2. agentStore（src/stores/agentStore.ts）
- WS 事件分发处新增 `session_title_changed` case → `applySessionTitle`（渲染链路 SessionItem 已从 store 读，自动刷新）。

### 3. 改名与播种的锁定语义
- `daemon-client/client.ts:273-277` + facade（:380,433）：`patchSession` 支持 `{ title, titleLocked?: boolean }`。
- 手动改名（SessionItem.tsx:137-148、SessionHeader.tsx:28）：传 `titleLocked: true`。
- 首条消息自动播种（agentStore.ts:2716-2732）：保持现状调用但显式不带 lock（即不锁定），保证原生标题后到仍可替换。

## 四、规则与边界

| 情形 | 行为 |
|---|---|
| 用户手动改名 | `title_locked=1`，此后所有原生标题刷新跳过 |
| 原生标题晚到 | 未锁定时覆盖播种截断标题（不 bump updated_at） |
| 标题未变化 | 不写库、不广播 |
| Claude summary 仍是首条消息（含截断） | 丢弃，等 ai-title 落盘后由阶梯重试再取 |
| Claude 生成/拉取均无结果 | 静默跳过，维持播种标题 |
| Claude 重新配置（模型/权限变更） | 取消待执行的阶梯定时器并重置标题状态，不重复发旧标题 |
| OpenCode 占位标题 | 不采纳（正则过滤） |
| fork 子会话 | 同规则：未锁定时原生标题可覆盖 "分支 · …"（fork 不锁定）；Codex/pi fork 不产生原生标题，维持现状 |
| 旧版 Claude SDK 无 generateSessionTitle / getSessionInfo | 静默跳过，维持播种标题 |
| 外部 settings.json 钉住上下文/压缩变量 | 子进程 env 与 `settings.env` 双清除，应用内上下文配置优先 |
| 导入会话（origin=imported） | 同规则，未锁定即可刷新（OpenCode 原生标题比截断更好） |

## 五、测试

- Sidecar vitest：`opencodeEvents.test.ts`（session.updated 变更才 emit、占位符过滤）、`claudeSessionTitle.test.ts`（生成即止、生成无结果回退、首条消息兜底丢弃、阶梯捡回迟到 ai-title、每会话只生成一次、reconfigure 撤销待执行梯子）、`claudeModelAliasEnv.test.ts`（上下文变量清除）。`claudeSubagentLifecycle.test.ts` 覆盖 `settings.env` 的上下文清除（含子进程 env）。codex（turn/completed 触发一次 thread/read、name 空跳过）、pi（session_info_changed → 信封）。
- Rust：`parse_agent_session_title_event` 解析测试；`refresh_auto_session_title` 三态（锁定跳过/未变跳过/正常写入）+ 截断归一化；schema 迁移 probe 测试（仿 schema.rs tests 的 legacy 表构造）。
- 前端 vitest：`sessionStore.test.ts` 的 applySessionTitle（含 archivedSessions）、agentStore 对 `session_title_changed` 的处理。

## 六、收尾门禁

1. `cd crates/daemon && cargo fmt --all -- --check` + `cargo clippy --all-targets --all-features -- -D warnings`
2. `npm run build:daemon`（改 Rust 后必做，提示用户重启 dev:desktop）
3. `cd apps/sidecar && npm run build`（tsc）
4. `npx vitest run`（根）+ `npx vitest run`（sidecar）全量通过
5. UI 改动需 `npm run build:web` 才对浏览器端生效（提示用户）

## 改动范围

- TypeScript：`apps/sidecar/src/` 下的 `opencodeEvents.ts`、`index.ts`、`codexAppServerRuntime.ts`、`piEvents.ts`、`piRuntime.ts`、`sdkLoader.ts`、`providerSdkTypes.d.ts`、`sessionTitleEvent.ts`、`claudeModelAliasEnv.ts`；前端 `sessionStore.ts`、`agentStore.ts`、`daemon-client/client.ts`、`daemon-facade.ts`、`SessionItem.tsx`/`SessionHeader.tsx`（改传参）
- Rust：`crates/daemon/src/db/schema.rs`、`db/operations.rs`、`agent/session_lifecycle.rs`、`companion/routes_extended.rs`、`companion/events.rs`
- 不新增任何 npm 依赖；不改 runtime 版本策略