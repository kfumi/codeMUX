# 子智能体独立时间线与实时预览

## Status

draft — 待确认

## Problem Statement

Claude 的异步 Agent/Task 会在父轮次给出 `result` 之后继续跑。CodeMUX 现在做了三件互相叠加的错事：

1. Sidecar 在父轮次 `result` 时调用 `closeQueryHandle('turn_complete')`，下一轮 `sendInput` 又会 `closeQueryHandle('new_turn')`。子智能体绑在这条 Claude query 上，query 一关就被掐死。
2. `claudeSdkMessageFilter` 在传输边界丢掉 `task_notification` 和 sidechain，前端看不到子智能体是否还在跑、跑完了没有。
3. 主对话把 Agent/Task 的立即返回（「Async agent launched successfully」）当成工具已执行。用户点卡片看不到子代理消息；再问「代理返回了吗」时，父代理用 `SendMessage` 去唤一个已经死掉的 child，模型把 SDK 拒绝说成「被你取消了」。

用户要的是：点主对话里的 Agent/Task 卡片，右侧预览面板单独、实时、流式看这个子智能体；关掉应用再打开同一会话，还能点开回看。面板只读。权限批准仍在父对话输入框上方。

## Solution

把子智能体做成父 Timeline 旁边的一条独立轨道，而不是往主事件流里塞 sidechain。

Sidecar 解释 Claude 的 task 协议和 sidechain，发出两种领域事件：`subagent_upsert`（描述符）和 `subagent_timeline`（子时间线上的一条 CodeMUX Event）。Rust 写入单独的 SQLite 表。前端 `subagentStore` 按 `sessionId + subagentId` 索引。点 Agent/Task 卡片，在现有右侧 `SidePanel` 打开 `kind: 'subagent'` 的 tab，用现有消息部件只读渲染这条时间线。

父 Timeline（`session_event_snapshots`）仍然不含 sidechain。权限请求继续走父会话的 `permission_requested`。Claude query 在会话存活期间保持打开：父轮次结束和下一轮 `sendInput` 都不得关掉仍有子智能体在跑的 query。

第一版只接 Claude。Store、协议、表、面板不绑 Claude 字段；OpenCode 以后只加适配器。

## User Stories

1. As a 桌面用户，我希望点主对话里的 Agent/Task 卡片后，右侧 SidePanel 打开该子智能体的 tab，以便单独看它在做什么，而不是在主对话里翻 sidechain。
2. As a 桌面用户，我希望子智能体还在跑时，面板里的文字和工具调用实时流式出现，以便确认它没卡住。
3. As a 桌面用户，我希望父代理已经说完、主输入框已空闲时，后台子智能体仍继续跑、面板仍继续更新，以便异步 Agent 不会被父轮次结束掐死。
4. As a 桌面用户，我希望在子智能体还在跑时往父对话再发一条消息（例如「它返回了吗」），不会仅仅因为新开一轮就杀掉这个子智能体，以便我能问父代理而不毁 child。
5. As a 桌面用户，我希望 Agent/Task 卡片在 child 仍在跑时显示「运行中」，而不是「已执行」，以便状态和事实一致。
6. As a 桌面用户，我希望 child 结束后卡片显示「已完成 / 失败 / 已取消」，并仍能点开面板回看完整时间线，以便验收结果。
7. As a 桌面用户，我希望关掉 CodeMUX 再打开同一会话，再点那张卡片仍能看到当时的时间线，以便异步任务的过程不会丢。
8. As a 桌面用户，我希望主对话里看不到子智能体的中间消息，以便父时间线保持可读。
9. As a 桌面用户，我希望 Agent 工具结果里不再出现 `agentId:`、`<usage>`、`SendMessage with to:` 这类内部元数据，以便卡片像普通工具摘要。
10. As a 桌面用户，我希望子智能体要批准工具时，批准卡片仍出现在父对话输入框上方，以便没开右侧 tab 也不会漏批。
11. As a 桌面用户，我希望打开着的子智能体面板把对应工具显示为等待批准，但不出现第二套批准按钮，以便只在一处操作。
12. As a 桌面用户，我希望点「停止」后，这个会话里还在跑的子智能体都停掉，以便 Stop 的含义仍然是停掉当前 Claude query。
13. As a 桌面用户，我希望后台 shell（`local_bash`）不会变成可点开的子智能体 tab，以便侧栏里只有真正的 Agent/Task/Workflow。
14. As a 桌面用户，我希望同一会话里多个子智能体各自一个 tab，再次点同一张卡片只是切到已有 tab，以便不重复堆叠。
15. As a 系统维护者，我希望父 Timeline 的加载、搜索、Companion、Fork 路径不需要理解 sidechain，以便 ADR 0003 的主时间线不被这次改动拆开。
16. As a 系统维护者，我希望 OpenCode 以后只实现一个协议适配器就能写入同一套 store / 表 / 面板，以便第一版的 Claude 细节不泄漏到 UI。
17. As a Mobile Companion 用户，我希望第一版主对话行为不变、也不会因为新事件类型崩溃，以便手机仍能看父时间线和批准。手机上不提供子智能体预览面板。

## Implementation Decisions

### 产品范围（一期）

- 桌面：只读子智能体 SidePanel tab + 主对话卡片状态 + 跨重启回放。
- 运行时：只接 Claude Agent/Task/Workflow（`task_type` 为 `local_agent` 或 `local_workflow`；无 `task_type` 时有 `subagent_type` 也算）。
- 持久化：本功能上线之后 Sidecar 捕获到的描述符和时间线。不回填上线前的 Claude 磁盘 `subagents/` 目录。
- 权限：子智能体的 `canUseTool` 仍在父 query 上触发，批准 UI 只在父 Composer。
- 发送：面板没有输入框，不能给子智能体发消息。

### 非目标（一期不做）

- 面板内给子智能体发消息、`SendMessage` UI、detach 成独立会话。
- 子智能体列表条、archive、hide from track。
- OpenCode / Codex / Gemini 适配器（seam 留下，代码不接）。
- 从 Claude 历史 JSONL / `subagents/` 目录回放上线前的旧会话。
- 子时间线分页（一期整段加载；单会话子智能体消息量按内存可承受处理）。
- Fork 会话时复制子智能体时间线。
- 用户 Stop 父轮次时仍保留 backgrounded child（Stop = 整条 query 结束 = 全部 child 终止）。
- 移动端 / Companion 上的子智能体预览。
- 把 `session_event_snapshots` 改名为 `session_timeline_events`（那是 Timeline 重构自己的事）。

### 模块与 seam

四个模块，调用方只通过各自接口交谈。Claude 字段不得出现在 Rust 表结构、前端 store 形状或 SidePanel 里。

```
Claude SDK 消息
    │
    ▼
ClaudeTaskProtocolSource + sidechain 路由     ← Sidecar，Claude 适配器
    │  SubagentObservation[]
    ▼
foldObservations → 领域事件                    ← 纯函数，provider 无关
    │  subagent_upsert / subagent_timeline
    ├──────────────────────────────► 父通道：permission_requested 等（不变）
    ▼
Rust Subagent Timeline                         ← SQLite 权威存储
    │
    ▼
subagentStore + SidePanel tab                  ← 前端，只读渲染
```

**1. Claude 适配器（Sidecar）**

Interface：`observe(sdkMessage) → SubagentObservation[]`，外加 `resolveSubagentId(toolUseId)`、`cancelRunningForegroundTasks()`、`failRunningTasks()`、`reset()`（仅会话拆除时调用）。

实现藏在 sidecar：`task_id` ↔ 规范 `subagentId`、tool_use_id 别名、是否 backgrounded、是否 workflow。对照 Paseo `ClaudeTaskProtocolSource`，行为对齐如下：

| Claude 公告 | 适配器行为 |
|---|---|
| `task_started` | 若 `skip_transcript` 或 `local_bash`（以及非 agent/workflow 的 task_type）则忽略。规范 id = 第一条 `tool_use_id`。同一 `task_id` 再次宣布时，新的 tool_use_id 记为别名，不新建描述符。发出 `declared`，并把 `prompt`（workflow 则用 `description`）写成时间线第一条 `user_message`。 |
| `task_updated` | 记录 `patch.is_backgrounded`；把 `patch.status` 映射为生命周期状态。 |
| `task_notification` | 映射终态；更新 subtitle 用量（可选）。 |
| `task_progress` | 只更新 subtitle/用量，不改生命周期。 |
| sidechain 帧（`isSidechain` 或非空 `parent_tool_use_id`） | 解析到规范 id 后，走现有 Claude→CodeMUX 投影，包进 `subagent_timeline`。未声明的 id 丢弃。 |
| 父轮次 `result` | 只取消明确未 backgrounded 的前台 child。已 `is_backgrounded` 的保持 `running`。从未见过 `is_backgrounded` 补丁、但规范 id 仍在且 query 未关的，也保持 `running`（异步 Agent 常见是父轮次先结束、child 后结束；不得只因父 `result` 就标 `canceled`）。 |
| 用户 Stop / query abort / 进程丢失 | `failRunningTasks()`：所有仍为 `running` 的 id（含 backgrounded）变为 `failed`。 |

状态映射：

| Claude status | CodeMUX status |
|---|---|
| pending / running / paused | `running` |
| completed | `completed` |
| failed | `failed` |
| killed / stopped | `canceled` |

Sticky upsert：省略的字段保持原值；显式 `null` 才清空。`status` 省略不得把已结束的描述符打回 `running`。

规范 id 就是父对话 Agent/Task 卡片的 `tool_use_id`。卡片点击、store 索引、tab id 都用它。`task_id` 和后续 tool_use_id 只存在适配器内部。

**2. 观察折叠（纯函数）**

`foldSubagentObservations(observations) → 领域事件[]`。`declared` / `status` / `subtitle` 变成 `subagent_upsert`；`timeline` 变成 `subagent_timeline`。无状态，live 与测试 fixture 共用。

**3. Subagent Timeline（Rust）**

Interface：

- `apply_upsert(session_id, descriptor)` → 写入描述符表
- `append_event(session_id, subagent_id, event_json)` → 按该子智能体自己的 `sequence` 追加
- `list(session_id)` → 描述符数组，按 `created_at`
- `load_timeline(session_id, subagent_id)` → 该子智能体的 CodeMUX Event 数组
- 删除父会话时 CASCADE

这是跨重启的权威存储。不读 Claude 磁盘文件。

**4. 前端 store + 面板**

`subagentStore` interface：

- `applyUpsert(sessionId, descriptor)`
- `appendEvent(sessionId, subagentId, event)`
- `replaceSession(sessionId, descriptors, timelines)`（打开会话时 hydration）
- `clearSession(sessionId)`
- `openInSidePanel(sessionId, subagentId)`

组件只通过 store 读描述符和事件；不解析 Claude SDK 消息。

### 领域事件（ADR 0003 扩展）

新增两类 CodeMUX Event。它们**不是**父 Timeline 成员：`timeline_persist.rs` 的父表白名单不收录它们；`loadSessionEvents` 不返回它们。

```ts
type SubagentStatus = 'running' | 'completed' | 'failed' | 'canceled';

type SubagentUpsertEvent = {
  type: 'subagent_upsert';
  session_id: string;
  subagent_id: string;
  provider: string;          // 一期为 'claude'；字段存在是为了多 agent
  title?: string | null;     // 子智能体类型或 Task name，如 Explore
  description?: string | null; // 这次任务在做什么
  status?: SubagentStatus;
  tool_call_id?: string | null; // 与 subagent_id 相同，除非别名解析后指向规范 id
  subtitle?: string | null;  // 适配器已经拼好的展示串，UI 不再解析 Claude usage
  event_id: string;
};

type SubagentTimelineEvent = {
  type: 'subagent_timeline';
  session_id: string;
  subagent_id: string;
  event: CodeMuxRuntimeEvent; // 与父时间线相同的领域事件（assistant_message、tool_started、text_delta…）
  event_id: string;
};
```

`subagent_timeline.event` 自带自己的 `event_id` / `sequence`。这里的 `sequence` 是**该子智能体时间线内**单调递增，与父 Timeline 的 `sequence` 独立，避免父序列出现空洞。

权限、提问、Turn Outcome 仍只出现在父通道。子智能体的工具若触发 `canUseTool`，Sidecar 继续 `emitTurnSource({ kind: 'permission_requested', ... })`，**不要**改写成 `subagent_timeline` 里的批准事件。子时间线可以有对应的 `tool_started`（尚无 `tool_finished`），面板据此显示等待。

传输层：`shouldForwardClaudeSdkMessage` 继续丢掉原始 sidechain 和 `task_notification`，避免它们漏进父 `AgentMessage`。适配器在丢掉之前先 `observe`，再发领域事件。前端 `parseAgentEvent` 遇到 `subagent_upsert` / `subagent_timeline` 时交给 `subagentStore`，不 `append` 到 `events[sessionId]`。

未知事件类型（Companion、旧前端）必须忽略，不得当作用户可见消息。

### Claude query 生命周期

当前错误路径：

1. `result` → `closeQueryHandle('turn_complete')` → `startWarmup`
2. 下一次 `sendInput` → 若仍有 handle 则 `closeQueryHandle('new_turn')` → 再 `query()`

异步 Agent 绑在第一条 query 上。关 handle 等于杀 child。

一期规则：

- Sidecar 会话一旦建立起 persistent query，就保持打开，直到：用户 Stop、空闲超时且**没有** `running` 子智能体、会话拆除、reconfigure、致命错误。
- 父轮次 `result`：**禁止** `closeQueryHandle('turn_complete')`。仍发出父通道 `turn_finished`，主输入框恢复空闲。然后 `cancelRunningForegroundTasks()`（跳过 backgrounded）。
- 下一次 `sendInput`：若 query handle 仍在，把新 prompt 写入现有 prompt stream，**禁止**为了「新一轮」关掉它。没有 handle 时才 `query()` / warmup。
- `turnIdleGuard.reset()` 必须在子智能体进度（sidechain、task_progress、task_notification）上调用。父 `result` 之后若仍有 `running` 子智能体，视为活动中，不得进入会关掉 query 的空闲倒计时。
- 用户 Stop：abort query，`failRunningTasks()`，然后允许 warmup。
- `startWarmup` 只在 handle 真正为 null 时发生，而不是每个父 `result` 之后。

`turnActive` 仍表示父轮次：`result` 后可以是 false，此时主 Composer 可发送。这与「query 仍开着、child 仍在跑」可以同时成立。

若 Claude SDK 的 prompt stream 无法在 `result` 之后再写入：退化为「有 running 子智能体时拒绝立刻关 query；新的 `sendInput` 等到所有 child 终态或用户 Stop」。这是降级，不是默认。实现时先走 prompt stream 复用；复用失败再在计划里写降级，不得默默关 query。

### 持久化

新建两张表，外键到 `sessions(id) ON DELETE CASCADE`。

```sql
CREATE TABLE IF NOT EXISTS session_subagents (
    session_id TEXT NOT NULL,
    subagent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    title TEXT,
    description TEXT,
    status TEXT NOT NULL,
    tool_call_id TEXT,
    subtitle TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, subagent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_subagent_events (
    session_id TEXT NOT NULL,
    subagent_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_timestamp TEXT,
    event_json TEXT NOT NULL,
    PRIMARY KEY (session_id, subagent_id, sequence),
    FOREIGN KEY (session_id, subagent_id)
        REFERENCES session_subagents(session_id, subagent_id) ON DELETE CASCADE
);
```

`event_json` 存的是内层 `CodeMuxRuntimeEvent`，不是外包的 `subagent_timeline` envelope。

实时路径：Sidecar stdout → `session_lifecycle` → 识别 `subagent_*` → 写这两张表，同时把同一 JSON 推给前端（现有 sidecar 事件推送）。不要把这些行插入 `session_event_snapshots`。

打开会话：现有 `loadSessionEvents` 只加载父 Timeline。另加 `load_session_subagents(session_id)`（描述符 + 每条子时间线事件）。前端 `loadSessionMessages` 在拉父 Timeline 的同时拉这一包，`replaceSession`。

幂等：同一 `event_id` 重复到达不得插第二行。upsert 用 sticky 语义更新描述符。

搜索、父 Timeline 分页、Companion 会话加载：不扫描 `session_subagent_events`。

### 前端与 UI

**卡片。** `Agent` / `Task` / `subagent` / `task` 工具在 `tool_call_id` 能对上描述符时：

- 状态取描述符，而不是 Agent 工具自己的 `tool_finished`。异步启动那条 tool result 只表示 child 已声明，不表示 child 已结束。
- 没有描述符时（协议未宣布）：保持今天的工具状态推断，避免旧会话卡片永远转圈。
- 标题区可点击（指针 + Enter/Space），调用 `openInSidePanel`。展开/折叠仍由卡片其余区域负责，交互对齐计划文件名点开 `openPlanTab`。
- 继续 `stripAgentToolResultMetadata`；「Async agent launched successfully」这类句子不作为完成文案展示，运行中卡片用「运行中」。

工具组摘要：对仍 `running` 的子智能体工具，禁止显示「已执行」。用「运行中」或省略完成态动词。

**SidePanel。** `SidePanelTabKind` 增加 `'subagent'`。

```ts
{
  id: `${scopeId}:subagent:${subagentId}`,
  kind: 'subagent',
  title: description || title || '子智能体',
  subagentId,
  sessionId,
}
```

内容区：只读消息列表。把该子智能体的 CodeMUX Event 数组交给现有 `convertAgentEvents`，再用现有 `CodeMuxMessageParts` / tool fallback 渲染。没有 Composer、没有 Queued Messages、没有 Stop 按钮（Stop 仍在父对话）。tab 标题旁可用状态点表示 running/completed/failed/canceled。

文件类工具在子面板里的点击行为与主对话相同：打开 SidePanel 的 file/diff tab。不要为子智能体再做一套文件预览。

**Hydration 与实时。** 先 `replaceSession`，再接收 live upsert/timeline。live 事件的 `event_id` 与已 hydration 的行冲突则忽略。切换会话时 `clearSession` 旧 id，避免串台。

**主对话过滤。** 继续丢弃 sidechain。`CodeMuxThread` 里用 `task_notification` 填工具时长的逻辑改为读描述符 subtitle/终态事件，不再依赖漏网的 raw `task_notification`。

### 错误与边界

- 适配器宣布之前就到达的 sidechain：丢弃，不进父时间线。
- 父 Agent 工具已 `tool_finished` 但从未 `task_started`：卡片按普通工具完成；不可打开子面板，或打开后空态「没有可显示的子智能体记录」。
- 描述符为 `running` 但进程已死（应用崩溃）：下次打开会话时，把仍为 `running` 的描述符写成 `failed`（打开时调和一次）。不在启动时扫描 Claude 磁盘。
- 子时间线投影失败：写 `diagnostic` 到该子时间线（内层 event），不要让 sidecar 崩。
- 父会话只读/导入：子表若空就空；不为导入会话伪造 child。

### 与 Paseo 的字段对齐

只对齐概念，不引入 Paseo 协议包。

| Paseo | CodeMUX 一期 |
|---|---|
| `ProviderSubagentDescriptor.id` | `subagent_id`（首个 `tool_use_id`） |
| `parentAgentId` | `session_id`（CodeMUX 没有独立 agent id） |
| `title` / `description` / `subtitle` | 同名 |
| `status` | 同四态 |
| `toolCallId` | `tool_call_id` |
| `ProviderSubagentStore` | Rust 表 + 前端 `subagentStore` |
| `AgentTimelineItem` | 内层 `CodeMuxRuntimeEvent`（沿用 ADR 0003，不新发明一套 item） |
| `agent.provider_subagents.update` | sidecar 事件 `subagent_upsert` / `subagent_timeline` |
| `AgentStreamView` 面板 | SidePanel `subagent` tab + 现有 message parts |
| 分页 `timeline.get` | 一期整段 `load_timeline` |
| detach / archive / 列表条 | 不做 |
| 磁盘 sidechain replay | 不做 |

### 文件落点（实现时）

Sidecar：`claudeTaskProtocolSource.ts`、`claudeSubagentObservations.ts`、在 `index.ts` 的 consume 循环里 observe、改 `closeQueryHandle` / `sendInput`、扩展 `codeMuxProtocol.ts`。过滤器保持丢原始帧。

Rust：`schema.rs` 建表、`operations` 增删改查、`timeline_persist` / `session_lifecycle` 分流 `subagent_*`、Tauri 命令 `load_session_subagents`。

前端：`stores/subagentStore.ts`、`sidePanelStore` 增 kind、`SubagentPreviewPanel.tsx`、`CodeMuxMessageParts` 卡片可点、`convertAgentEvents` 用描述符覆盖 Agent 工具状态、`agentStore` 路由新事件并在 `loadSessionMessages` 时 hydration。

测试：适配器 fixture（task_started 别名、backgrounded、local_bash 过滤、sidechain 路由）；fold 纯函数；Rust sticky upsert 与 CASCADE；store hydration/去重；卡片状态；query 在 `result` 后仍打开、`sendInput` 不关仍有 running child 的 handle。

## Testing Decisions

好的测试只断言模块对外行为。三条测试缝，不要为 UI 内部 className 或 SQL 文本再开对等缝。

**缝 1：Claude 适配器。** 给定 SDK 消息序列，得到观察值。覆盖：宣布 Explore、别名 tool_use_id、backgrounded 在父 `result` 后仍 running、非 backgrounded 在父 `result` 后 canceled、`local_bash` 不宣布、sidechain 进规范 id、未宣布 id 的 sidechain 丢弃、Stop 后全部 running 变 failed。

**缝 2：Rust Subagent Timeline。** `apply` + `append` + `list` + `load`。覆盖：sticky upsert、重复 `event_id` 不双写、删 session CASCADE、打开时把遗留 `running` 标为 `failed`。

**缝 3：前端 store 与卡片状态。** 给定 upsert/timeline 事件，store 形状正确；Agent 工具在描述符 `running` 时卡片为 running；点卡片打开 `kind: 'subagent'` tab；`loadSessionMessages` 之后能回放。父 `events` 数组不含 `subagent_*` 和 sidechain。

Sidecar 生命周期：`result` 之后 handle 非 null；存在 running 子智能体时 `sendInput` 不走 `closeQueryHandle('new_turn')`。

### Codex 适配器(三期,已实现)

Codex 走 app-server 协议(ADR 0010),collab 子代理是同进程里的真实 thread。与 OpenCode 的关键差异:声明信号是父线程上的 `collabAgentToolCall` item(而非 message part),子线程通知与父线程走**同一条 JSON-RPC 连接**(按通知里的 `threadId` 归属),父 turn 会阻塞在 `wait` 工具上直到子代理收尾,因此不存在 Claude「父 result 掐死 query」问题,不需要 query 保活改造。`turn/start` 不需要额外参数——collab 在 codex 0.146+ 默认可用(参考 Paseo,未传 `multiAgentMode` 也工作)。

| Codex 信号 | 适配器行为 |
|---|---|
| 父线程 `item/started`+`item/completed`,`item.type === 'collabAgentToolCall'` | 发出 `declared`:规范 id = item id(父对话子智能体卡片 id),`prompt` 写成时间线第一条 `user_message`;`tool === 'spawnAgent'` 的 item 投影为父时间线卡片(`tool_started`/`tool_finished`,工具名 `subagent`,必须与前端 `isSubAgentTool` 白名单一致才有预览 chip 与点击);`wait`/`sendInput`/`closeAgent` 等编排调用不出父卡片。`receiverThreadIds` 逐个注册进 `childThreadId → 规范 id` 路由表;`agentsStates` 聚合为描述符状态。 |
| 父线程 item `subAgentActivity`(`kind: started/interacted/interrupted`) | `agentThreadId` 注册进路由表(若尚未注册);`started`/`interacted` 只补状态,`interrupted` → `canceled`。 |
| 子线程 `item/started` / `item/completed` / `item/agentMessage/delta` / `item/reasoning/*` / `turn/completed` 等 | 复用与父线程相同的投影逻辑(`adaptAppServerItem` + 流式 delta),折回 `TurnSourceEvent` 包进 `subagent_timeline`;流式状态(`streamingParts`、去重集)按子线程各一份。 |
| 子线程 `turn/completed` | `status: completed`(interrupted → canceled,failed → failed)。 |
| 竞态:子线程通知早于声明到达 | pending 缓冲(每线程上限 128 条,线程数上限 32,溢出丢弃最旧),声明注册后按序重放。 |
| codex 对同一 spawn 发两次 `item/started`(首次无 `receiverThreadIds`,子线程创建后带 id 重新宣布) | 二次宣布按 prompt 合并进首次轨道(unresolved-spawn 表;多个候选时 prompt 唯一匹配,唯一候选免匹配);别名 item 不渲染父卡片,其完成结果重定向为规范卡片的 `tool_finished`。真机实证(2026-08-30):不合并会产生永远 `running` 的幽灵描述符,子时间线挂错轨道。 |
| 用户 Stop / `turn/interrupt` / runtime teardown | `failRunningTasks()`:所有 `running` 描述符变 `failed`。 |

状态映射(Paseo 验证过的坑):`running/pendingInit/inProgress` → `running`;`errored` → `running`(turn 可能重试,不得提前判死);`shutdown` → `canceled`;`notFound` → `failed`;`completed` → `completed`;item 级 `failed` → `failed`。

权限:子线程审批请求与父线程同通道(approval bridge 按 `params.threadId` 记录但决策统一),批准 UI 只在父 Composer,与一期规则一致,无额外改造。

回放:live 捕获写入 `session_subagent_events` 之外,CLI 历史同步(`import_sessions` / `resync_session_from_native`)也会从磁盘回填:codex 每个 collab 子代理有独立 rollout 文件(`thread_source=subagent`,`parent_thread_id` 指向父线程),父 rollout 里成功的 `spawn_agent` 输出携带 `{"agent_id","nickname"}` 把 `call_id` 与子 rollout 绑定(`codex_subagent_history.rs`)。失败的重试尝试(纯文本错误输出)不产生轨道。

CLI 历史投影与 live 对齐(`codex_history.rs`):`spawn_agent` 只在输出确认启动了子线程时出卡片(改名 `subagent`,input 收敛为 `{prompt}`);`wait_agent`/`close_agent`/`send_input`/`resume_agent` 编排调用与失败重试一律不出父卡片——同一 spawn 被模型重复调用(真机实证:参数错误重试会产生第二个 call_id)时按 prompt 去重,先成功者得卡片。

文件落点:`codexSubagentObservations.ts`(纯函数:collab item 观察、子线程通知→TurnSourceEvent 投影)、`codexSubagentSource.ts`(路由表、pending 缓冲、per-thread 流式状态、failRunningTasks/reset)、`codexAppServerRuntime.ts` 接线(`handleNotification` 按 threadId 分流 + collab item 分支)。`claudeSubagentFold` 原样复用(`provider: 'codex'`)。Rust 表、前端 store、SidePanel 零改动。

## Further Notes

- 二期若接 OpenCode：只新增适配器，把 OpenCode 子会话事件折成同一套 Observation。不要给 SidePanel 加 `opencode_subagent` kind。

### OpenCode 适配器（二期，已实现）

OpenCode 与 Claude 的差异：子代理跑在带独立 `sessionID` 的子 session 里，所有子 session 事件与父 session 走同一条 SSE 事件总线；没有 task_started/sidechain 协议，声明信号是父 session 上的两种 part。Rust 表、前端 store、SidePanel 零改动（`provider` 一直是普通字符串）。

| OpenCode 信号 | 适配器行为 |
|---|---|
| 父 session `message.part.updated`，`part.type === 'subtask'` | 发出 `declared`：规范 id = `part.id`（无 id 用 `callID`），`title = part.agent`，`description = part.description`，`prompt = part.prompt` 写成时间线第一条 `user_message`。同一 part 重复发布走 sticky 合并，不重复宣布。 |
| 父 session `message.part.updated`，`part.type === 'tool'`、工具名 `task`/`agent`（忽略大小写）、`state.metadata.sessionId` 指向子 session | 绑定 `childSessionId → 规范 id`。若 `callID` 已是别名或规范 id 则只绑定；否则优先按 `messageID` 匹配本轮里尚未绑定的 subtask 声明（注册 `callID` 为别名）；都匹配不上才用 `state.input`（`subagent_type`/`agent`/`description`/`prompt`）新建声明。 |
| 子 session 的 `message.part.updated` / `message.part.delta` / `message.updated` 等 | 复用 `toCodeMuxEvent` 投影（每个子 session 一份独立 streamingParts / nextSection / idleStreamKind / userMessageIds 状态，子 session 的用户 prompt 文本经 `userMessageIds` 抑制，避免与声明的 prompt 重复），把投影结果反折回 `TurnSourceEvent`（`assistant_message`、流事件、`tool_started/finished`、`error`；`turn_finished`/`system_event`/`diagnostic`/`permission_requested` 丢弃），包进 `subagent_timeline`。未绑定的子 session 事件丢弃（与 Claude 未宣布 sidechain 一致）。 |
| 子 session `session.idle` | `status: completed`（投影出的 `turn_finished` 不进子时间线）。 |
| 子 session `session.error` | 投影出的 `error` 事件进子时间线 + `status: failed`。 |
| 子 session `session.interrupted` / `session.aborted` | `status: canceled`。 |
| 子 session `permission.asked`/`question.asked` | 不进适配器：runtime 对任意 session 的权限/提问事件本来就在 session 过滤之前全局处理，批准 UI 只在父 Composer（与一期规则一致）。 |
| 子 session `session.status`（`free_tier_limit`） | 维持现状：提升为父轮次失败；同时该子智能体描述符标 `failed`。 |
| 用户 Stop / interrupt / runtime dispose | 先对子 session 尽力 `abort`，再 `failRunningTasks()`：所有 `running` 描述符变 `failed`。 |
| `resetSession` | 适配器 `reset()`（仅会话拆除）。 |

规范 id 的取法与 Claude 相同：声明信号给出的父侧工具调用 id（subtask part 的 `part.id` / Task 工具 part 的 `callID`），即父对话 Task 卡片的 `tool_use_id`；`childSessionId` 只存在适配器内部。

OpenCode 没有 Claude 的「父轮次 result 掐死 query」问题：runtime 在子任务未结束时本来就忽略父 `session.idle`（等待子任务完成），因此不需要 query 保活改造；子智能体仍在跑时，turn 空闲守卫同样视为活动中（守卫挂起）。

文件落点：`opencodeSubagentObservations.ts`（纯函数：声明提取、子事件投影、CodeMUX→TurnSourceEvent 反折）、`opencodeSubagentSource.ts`（有状态控制器：fold 状态、sessionToSubagent 绑定、failRunningTasks/failSession/reset）、`opencodeRuntime.ts` 接线。`claudeSubagentFold.ts` 的 `provider` 字段从 `'claude'` 字面量放宽为 `string`，fold 本体不改。
- 二期若做面板发送：那是新的领域动作，不是把 Composer 抄进 tab。一期面板不要预留禁用输入框。
- 二期若回填 Claude 磁盘：作为 hydration adapter 写入 Rust 表，前端仍然只读 `load_session_subagents`。
- 与 ADR 0003、0004 相容：子轨道是领域事件的旁路存储，不是第二套父 Timeline；子智能体权限仍是父会话上的 Interactive Request，空闲守卫在等待人类时挂起的规则不变，并扩展为「有 running 子智能体时也不得因父 `result` 而关 query」。
