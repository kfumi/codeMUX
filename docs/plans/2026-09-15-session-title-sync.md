# 会话标题自动同步（底层标题 → CodeMUX）

## 目标与原则（已与用户确认）

- **不自建 LLM 标题生成**：标题优先采用底层 runtime 自己产出的（OpenCode 事件推送、Claude ai-title 拉取、Codex/pi 的 name——有则用），没有原生标题的（Codex/pi 现状）维持现有"首条用户消息截断"兜底。
- **不回写底层 runtime**：不改 Claude `renameSession`、Codex `thread/name/set`、pi `set_session_name`。
- **用户手动改名后锁定**（参考 codeg 的 `title_locked` 语义），原生标题不再覆盖。
- 现有"首条消息播种"保留：前端 `agentStore.ts:2716` 的自动标题作为播种，原生标题晚到时替换它（未加锁时）。

## 统一协议：新增 sidecar 控制信封 `agent_session_title`

```json
{ "type": "agent_session_title", "app_session_id": "...", "agent_kind": "opencode",
  "title": "...", "runtime_generation": 1 }
```

非 timeline 控制事件，与 `agent_session_mapping` 同类：不进 `isCodeMuxDomainEvent` / `CODE_MUX_DOMAIN_EVENT_TYPES`，不落 timeline。

## 一、Sidecar（src-tauri/sidecar/src/）

### 1. OpenCode（推送式，白捡）
- `opencodeEvents.ts:341-343`：`session.updated` 分支从 `properties.info` 读 `title`。
- 去重与过滤：runtime 实例内记录 `lastEmittedTitle`（初始为空）；只在该 session 的 title 发生变化且非空时 emit；过滤占位标题（`/^New session - /`、`/^Child session - /`，会话刚创建时会推占位符，不能让它覆盖播种标题）。
- 通过现有 `emit()` 发 `agent_session_title` 信封（`session_id` = ctx.sessionId，含 `runtime_generation`）。

### 2. Claude（首轮后拉取一次）
- `index.ts:1438` result/turn-close 分支处：每 session 一次性（`titleSynced` 标志，fire-and-forget，带 try/catch），调用 `queryHandle.getSessionInfo(sdkSessionId)`（SDK 句柄 `SessionRuntime.queryHandle` 全程保留，index.ts:311/861）。
- 防御式：`typeof queryHandle.getSessionInfo !== 'function'` 或返回 `summary` 为空则跳过（旧版本 SDK 无此 API，不做最低版本强限）。`SDKSessionInfo.summary` 本身就是 custom → ai-title → first prompt 的兜底链。
- `sdkLoader.ts:7-10` 的 `ClaudeSdkModule` 与 `providerSdkTypes.d.ts` 不需要扩展（方法在 query 句柄上，句柄类型本就是 `any`/`Query=any`）。

### 3. Codex（首轮后探测一次）
- `codexAppServerRuntime.ts:982-1007` `turn/completed` 处：每 thread 一次性（`titleSynced` 标志）新增 `transport.request('thread/read', { threadId })`（仿 :1385 resume 的请求写法），读到 `thread.name` 非空才 emit；`name` 为空/请求失败静默跳过（Codex 现状无自动命名，纯前向兼容 + 接住 TUI 侧命名的场景）。

### 4. pi（跟随原生改名）
- `piEvents.ts:246-275` 补 `session_info_changed` case：`name` 非空时 emit `agent_session_title`。
- `piRuntime.ts:538-548` `readSessionIdentity` 已有的 `get_state` 里顺带读 `sessionName`，非空时 emit 一次。

### 5. 公共发射器
- 新建小工具（如 `sessionTitleEvent.ts`）：`buildSessionTitleEvent({ appSessionId, agentKind, title, runtimeGeneration? })`，各 runtime 复用；index.ts 的 opencode/pi mapping builder 旁边加对应 builder（照 index.ts:100-130 模式）。

## 二、Daemon（src-tauri/src/）

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
| OpenCode 占位标题 | 不采纳（正则过滤） |
| fork 子会话 | 同规则：未锁定时原生标题可覆盖 "分支 · …"（fork 不锁定）；Codex/pi fork 不产生原生标题，维持现状 |
| 旧版 Claude SDK 无 getSessionInfo | 静默跳过，维持播种标题 |
| 导入会话（origin=imported） | 同规则，未锁定即可刷新（OpenCode 原生标题比截断更好） |

## 五、测试

- Sidecar vitest：`opencodeEvents.test.ts`（session.updated 变更才 emit、占位符过滤）、新增 claude 标题同步 helper 的单测（可把 fire-once/防御逻辑抽成纯函数）、codex（turn/completed 触发一次 thread/read、name 空跳过）、pi（session_info_changed → 信封）。
- Rust：`parse_agent_session_title_event` 解析测试；`refresh_auto_session_title` 三态（锁定跳过/未变跳过/正常写入）+ 截断归一化；schema 迁移 probe 测试（仿 schema.rs tests 的 legacy 表构造）。
- 前端 vitest：`sessionStore.test.ts` 的 applySessionTitle（含 archivedSessions）、agentStore 对 `session_title_changed` 的处理。

## 六、收尾门禁

1. `cd src-tauri && cargo fmt --all -- --check` + `cargo clippy --all-targets --all-features -- -D warnings`
2. `npm run build:daemon`（改 Rust 后必做，提示用户重启 dev:desktop）
3. `cd src-tauri/sidecar && npm run build`（tsc）
4. `npx vitest run`（根）+ `npx vitest run`（sidecar）全量通过
5. UI 改动需 `npm run build:web` 才对浏览器端生效（提示用户）

## 改动范围

- TypeScript：`opencodeEvents.ts`、`index.ts`、`codexAppServerRuntime.ts`、`piEvents.ts`、`piRuntime.ts`、新增 title 事件工具；前端 `sessionStore.ts`、`agentStore.ts`、`daemon-client/client.ts`、`daemon-facade.ts`、`SessionItem.tsx`/`SessionHeader.tsx`（改传参）
- Rust：`db/schema.rs`、`db/operations.rs`、`agent/session_lifecycle.rs`、`companion/routes_extended.rs`、`companion/events.rs`
- 不新增任何 npm 依赖；不改 runtime 版本策略