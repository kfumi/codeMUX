# Codex 协作子智能体：两种 spawn 变体的声明与轨道对等

**Status:** ready-for-agent

## Problem Statement

用户在 Codex 会话里让 agent「用两个子智能体总结…」时，agent 在父时间线明确说已经派出子智能体，但之后**一个子智能体消息都没有**：

- 父时间线里没有可点击的子智能体卡片（委派卡片），因此也进不去子智能体预览面板；
- 子智能体面板里没有任何内容（子线程的推理流、助手消息、工具调用全部不可见），轨道事件数为 0；
- 取而代之的是若干**空的「Sub-agent」条目**：标题固定、描述为空、内容永远为 0——它们其实是父 agent 自己的 `wait_agent` 编排调用，被当成了子智能体；
- 父 agent 因为等不到子智能体产出而反复 `wait_agent`，整轮长时间停在「正在执行」不结束（实测 18 分钟仍在轮询，累计 input token 从 2.6 万涨到 78 万），用户只能手动停止。

同一个 CodeMUX 版本、同一个 Codex CLI（0.146.1）下，用户换个模型/另一次会话时同样的操作却是正常的——说明这不是能力缺失，而是**只覆盖了其中一种 spawn 形态**。

## Solution

让 Codex 子智能体的声明与轨道对等：**无论 spawn 走哪一种 codex 协作变体，CodeMUX 都要建立子智能体轨道、把子线程的流式事件投影进轨道、并在父时间线给出可点击的委派卡片**。同时收紧声明语义：只有真正派生子智能体的调用才能创建轨道，`wait_agent` 这类编排调用不再产生任何轨道或卡片。

用户可见的变化：

- 无论哪种变体，父对话出现可点击的子智能体卡片，点开可见子智能体的实时推理、消息与工具调用；
- 面板不再出现标题为「Sub-agent」、内容永远为空的伪条目；
- 父时间线不再出现「Sub-agent call completed」这类没有对应开始的孤儿结果行；
- 嵌套派生的孙智能体同样可见（扁平轨道，不做缩进）。

## User Stories

### 可见性与入口

1. As a Codex 用户，我希望 agent 派生子智能体后父对话里立刻出现委派卡片，以便知道它派了谁、能点进去看进度。
2. As a Codex 用户，我希望子智能体的推理流、助手消息与工具调用实时出现在预览面板里，以便判断它是否在做正确的事。
3. As a Codex 用户，我希望子智能体卡片能显示这个子智能体的名字/路径，以便在同一次派了多个时区分它们。
4. As a Codex 用户，我希望卡片上能一路看到子智能体的运行/完成/失败状态，以便不必逐条翻时间线。
5. As a Codex 用户，我希望子智能体完成后卡片状态自动收敛为「已完成」，以便知道这一支已经收工。
6. As a Codex 用户，我希望子智能体失败时卡片显示失败而不是一直「运行中」，以便及时介入。
7. As a Codex 用户，我希望被中断的子智能体显示为「已取消」，以便与失败区分。
8. As a Codex 用户，我希望同一个子智能体在父时间线只出现一张卡片，以便不被重复条目淹没。
9. As a Codex 用户，我希望派了多个子智能体时每个都有自己的卡片与轨道，以便分别查看。
10. As a Codex 用户，我希望刷新/重开会话后子智能体轨道内容仍在，以便回溯。

### 正确性与语义

11. As a Codex 用户，我希望「派了两个子智能体」这件事在 UI 上就是两张卡片，而不是若干条空条目。
12. As a Codex 用户，我希望 `wait_agent`、`send_input`、`resume_agent`、`close_agent` 这类编排调用不出现在对话里，以便时间线只表达真实工作。
13. As a 维护者，我希望编排调用即使带目标线程 id 也只把结果归到已存在的子智能体上，以便不产生新轨道。
14. As a 维护者，我希望编排调用不带目标线程 id 时**不创建任何轨道、也不渲染任何结果行**，以便彻底消除伪条目。
15. As a Codex 用户，当同一个 spawn 被宣告两次（一次不带子线程 id、后一次带）时，我希望只得到一张卡片、一条轨道，以便不被重复宣告干扰。
16. As a Codex 用户，当子线程的通知先于声明到达时，我希望这些内容在声明登记后按原顺序补齐，以便不丢开头。
17. As a Codex 用户，当子智能体自己也派子智能体（孙智能体）时，我希望孙智能体同样可见，以便看懂整棵协作树。
18. As a 维护者，我希望声明信号在同一条 spawn 上幂等，以便 codex 重复推送同一事件时不会重复建轨道。
19. As a 维护者，我希望未知线程 id 的流量始终被缓冲而不是丢弃，以便声明迟到时不丢内容。
20. As a 维护者，我希望缓冲层面对同一线程的重复通知不会撑爆内存，以便长时间会话稳定。

### 两种变体的对等

21. As a Codex 用户，我希望用「带命名的团队路径」方式派生子智能体（子线程由父线程历史 fork 而来）时也能看到子智能体，以便不被实现差异区别对待。
22. As a Codex 用户，我希望用「自动昵称」方式派生子智能体时行为与今天一致，以便本次改动不造成回归。
23. As a Codex 用户，我希望子智能体的任务描述无论来自哪种变体都能在面板里看到，以便知道它被要求做什么。
24. As a 维护者，我希望子智能体的轨道 id 在两种变体下都等于该次派生调用的 call id，以便前端按 toolCallId 关联卡片与轨道的既有逻辑无需分叉。
25. As a 维护者，我希望父卡片使用的工具名在两种变体下一致，以便前端委派工具白名单、活动分组与侧栏入口无需分叉。
26. As a 维护者，我希望子智能体的显示名在缺少昵称时退回 agent 路径，以便至少能区分身份。
27. As a 维护者，我希望这次改动只触及 Sidecar 的 Codex 适配层，不新增 Daemon 表结构、不改 CodeMUX Event 协议，以便风险可控。
28. As a 维护者，我希望实现不依赖「父线程一定能收到派生的工具调用条目」这一假设，以便上游变体或版本变化时不再整支静默。

### 回归与稳定性

29. As a Codex 用户，我希望现有的 Codex 会话与历史回放不受影响，以便升级后不丢已有子智能体轨道。
30. As a Codex 用户，我希望 Claude Code 与 OpenCode 的子智能体链路完全不受影响，以便多智能体体验保持一致。
31. As a 维护者，我希望历史回放（从原生会话文件回填）与实时链路产生同样的轨道与 id，以便两种来源可对齐。
32. As a 维护者，我希望没有子智能体的普通会话完全不产生子智能体事件，以便不引入噪声。
33. As a 维护者，我希望本次改动可由真实抓包快照驱动单测覆盖，以便回归可复现。
34. As a 维护者，我希望端到端用假 app-server 场景验证通知序列，以便覆盖路由与折叠的接线。

### 诊断

35. As a 维护者，我希望遇到未识别的 app-server 通知时不崩不卡，只是不影响对话，以便上游协议演进安全。
36. As a 维护者，在排查子智能体不可见时，我希望有一条可开关的原始通知轨迹，以便快速定位是「没到」还是「到了被丢」。

## Implementation Decisions

### 术语与现状

- 沿用既有子智能体流式设计的词汇：**子智能体轨道**（subagent track）、**父卡片**（父时间线上的委派卡片）、**声明**（建立轨道与线程路由）。本 spec 是对既有子智能体流式设计的扩展，不改变其对外语义。领域词汇（Session / Native Session / Agent Kind / Sidecar / CodeMUX Event / Turn Outcome / Interactive Request）取自 `CONTEXT.md`。
- 现有实现假定声明信号是父线程上的 `collabAgentToolCall` 条目（工具名 `spawnAgent`），其 `item/completed` 带 `receiverThreadIds`，据此登记子线程路由。真实 wire 快照证明 codex 0.146.1 存在**两套**协作实现，只有一套符合该假设。

### 真实 wire 证据（来自本机抓包，非推测）

变体 A（tid=thread-spawn / 自动昵称，现状可用）：

```
item/started   {type:'collabAgentToolCall', id:'call_a259…', tool:'spawnAgent', status:'inProgress', prompt:'…', receiverThreadIds:[]}
item/completed {type:'collabAgentToolCall', id:'call_a259…', tool:'spawnAgent', status:'completed', receiverThreadIds:['01a0ba3f-a078-…']}
```

变体 B（agent path / 父历史 fork，现状整支静默）：

```
item/started/completed {type:'subAgentActivity', id:'call_00_KapLrhSWlODQdZDkANYI1759', kind:'started',
                        agentThreadId:'01a0ba42-c01b-…', agentPath:'/root/scan_src'}
item/started           {type:'collabAgentToolCall', id:'call_00_hgxony…', tool:'wait', status:'inProgress', receiverThreadIds:[]}
```

即：变体 B **完全没有 `spawnAgent` 的 collab 条目**，`collabAgentToolCall` 只出现 `wait`；子线程归属只出现在 `subAgentActivity`（`item.id` 就是该次派生的 call id，`agentThreadId` 就是子线程 id）。`thread/started` 不会为协作子线程发出，因此不能作为绑定来源。

### 决策

- **D1｜`subAgentActivity` 提升为一等声明源**：`subAgentActivity` 条目（父线程与子线程上都可能到达）在 `item/started`/`item/completed` 时都要参与声明与路由登记；不再要求「先有 `collabAgentToolCall` 声明」才处理它。
- **D2｜轨道 canonical id 与路由键**：以 `subAgentActivity.id`（该次派生的 call id）作为轨道 canonical `subagent_id` 与父卡片 `tool_call_id`；以 `agentThreadId` 作为子线程路由键（等价于变体 A 的 `receiverThreadIds` 登记）。两种变体下 id 语义统一，前端按 `toolCallId` 关联卡片与轨道的既有逻辑不分叉。
- **D3｜父卡片**：变体 B 也要为每次派生发出与变体 A 同形的父卡片（工具名沿用现有委派白名单里的 `subagent`，`tool_use_id` = 派生 call id）。卡片输入不得编造：变体 B 拿不到 prompt，只能带 agent 路径；子智能体的任务原文由子线程自己的入站消息在轨道里呈现。
- **D4｜显示名**：`title` 取 agent 路径末段（如 `scan_src`），`subtitle` 取完整 agent 路径（如 `/root/scan_src`）；缺失 agent 路径时退回既有「未命名子智能体」回退策略。昵称可用时优先昵称。
- **D5｜声明收紧**：只有 `tool === 'spawnAgent'` 的 collab 条目可以创建新轨道；`wait`/`sendInput`/`resumeAgent`/`closeAgent` 只允许作为已声明子智能体的别名（记录 tool_use_id、聚合状态），目标未知时一律丢弃（状态观察对未知任务本来就是 no-op，折叠层无需改动）。
- **D6｜结果行收口**：collab 条的完成结果只在 `spawnAgent` 卡片存在时输出，编排调用不再产生「Sub-agent call completed」这类孤儿结果。
- **D7｜子路由内的声明**：子线程上的 `subAgentActivity` 同样要声明（孙智能体）并登记其路由，且在 pending 回放路径里也生效。轨道保持**扁平**：本次不引入层级/缩进语义，父子关系靠 agent 路径表达。
- **D8｜活动与终态映射**：`kind=interrupted` → 轨道取消；`kind=started` 建立轨道；`kind=interacted` 不新建、不改状态（仅可刷新 subtitle）；子线程 `turn/completed` 的终态映射沿用现状（completed / interrupted→canceled / failed）。
- **D9｜幂等**：同一 call id 的重复宣告（含 started 与 completed 两条同 `kind=started` 的记录、以及变体 A 的二次宣告）只能产生一条轨道、一次父卡片。
- **D10｜回放**：登记路由后立即回放该线程的缓冲通知（含嵌套声明），顺序保持到达顺序；缓冲上限与裁剪策略本次不改（见 Out of Scope），但实现不得因此把声明类通知整条丢掉。
- **D11｜改动范围**：只改 Sidecar 的 Codex 适配层三个模块——`CodexSubagentSource`（声明与路由状态机）、`codexSubagentObservations`（纯解析/投影，含 `subAgentActivity` 的解析与子路由投影）、`CodexAppServerRuntime`（通知路由与父卡片合成）。不新增 Daemon 表结构、不改 CodeMUX Event 协议、不改前端：`subagent_upsert` / `subagent_timeline` 已能承载（含 `title`/`description`/`subtitle`/`tool_call_id`/`status`）。

## Testing Decisions

- **好测试的标准**：只断言外部可观察行为——发出的 `subagent_upsert` / `subagent_timeline` 事件序列、`routeThreadId` 的判定结果、以及父时间线事件；不断言内部 map/字段结构。测试用例的输入必须来自真实 wire 快照（本 spec 的证据段落），而不是手工编造的乐观 payload。
- **seam 1（首选、最高性价比）**：`CodexSubagentSource` 的公开接口（既有的 `observeParentItem` / `observeChildNotification` / `routeThreadId`）。单测落在既有 `codexSubagentSource.test.ts` 旁边，覆盖：变体 B 父路由声明、变体 B 子路由（孙）声明、pending 回放、`wait`（带/不带 receivers）不建轨道、幂等宣告、`interrupted`→canceled、未知线程仍缓冲。
- **seam 2（接线）**：`CodexAppServerRuntime` 的假 app-server 场景（既有 `codexAppServerRuntime.test.ts` 的 `createHarness` + `thenNotifications` 风格）。新增一条变体 B 的完整通知序列（父线程 `subAgentActivity` + 子线程 delta/`turn/completed`），断言父卡片与轨道事件都出现、且没有编排条目产生的轨道。
- **回归门槛**：`npx vitest run src/codexAppServerRuntime.test.ts src/codexSubagentSource.test.ts`（在 `src-tauri/sidecar`）+ 根目录 `npm run build:sidecar`；不需要 Rust 侧改动。
- **手工验收**：用「让 agent 派两个子智能体」的提示分别跑一次两种变体（模型选择会决定变体），确认卡片、面板内容与状态收敛；抓包轨迹可用于核对。

## Out of Scope

- **缓冲上限与回放裁剪策略**（既有 pending 缓冲按「32 线程 × 每线程 128 条」截断；本次不改，只要求在声明登记时回放）。作为已知风险记录在 Further Notes。
- **子线程的模型/供应商继承**：实测变体 A 下子线程继承的是全局 `~/.codex/config.toml` 的模型而非会话模型，导致派生随机失败（`Service tier default is not supported for model …`、`模型不存在`）。属独立缺陷，另开。
- **CLI 历史回填绑定**（Rust 侧）：从原生会话文件回填轨道目前依赖派生输出里的 `agent_id`/`nickname`，变体 B 不产出该字段；本次不动。
- **并发槽位与死锁防护**：codex 团队只有 4 个并发槽（含主线程），模型递归派生会耗尽导致整队卡死；本次不做 UI 提示、不做指令注入限制。
- **面板层级**：不做缩进/树形拓扑、不做跨 Agent Kind 的子智能体 UI 统一。
- **Claude Code / OpenCode 子智能体链路**：本次不动。
- **子线程入站任务的语义保真**：子智能体收到的任务消息当前会按助手消息投影，本次不修。

## Further Notes

- **变体判定**：两种变体由 codex 侧决定（同一 CLI 版本、同一 CodeMUX 版本下，不同会话会走不同变体。触发条件未完全定位，与模型/团队指令形态相关）。实现必须对两种变体都成立，不得把变体 A 当作唯一事实。
- **死锁机制（现场证据）**：codex 注入的团队指令原文写着 `There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.` 主线程 + 2 个子 + 1 个孙即满；第 5 次派生被拒（`collab spawn failed: agent thread limit reached`），子代理退化为 `wait_agent` 重试循环，父轮永不结束。这是「一直卡在正在执行」的直接原因；本 spec 只解决子智能体可见性，死锁防护见 Out of Scope。
- **证据与复现**：本次排查基于本机原始通知轨迹（`%TEMP%\codemux-collab-trace.jsonl`，按 pid 分段）、codex 原生 rollout 文件、Daemon 的 `session_subagents` / `session_subagent_events` 表，以及 `codex app-server generate-json-schema` 生成的协议 schema（`CollabAgentTool` 枚举含 `spawnAgent/sendInput/resumeAgent/wait/closeAgent`；`CollabAgentToolCallThreadItem.receiverThreadIds` 注释明确「spawn 时对应新派出的 agent」；`SubAgentActivityThreadItem` 必填 `id`/`agentThreadId`/`agentPath`/`kind`）。
- **两次对照（实测数字）**：变体 A 会话 6 条轨道（全部来自 spawn，带 prompt）、其中一条子轨道落库 391 条事件；变体 B 会话 4 条轨道（全部来自 `wait`，`description` 为空）、落库事件 0 条。
- **埋点现状**：Sidecar 里存在一批临时诊断埋点（一个独立模块 + 4 处调用：通知入口、路由判定后、子智能体事件出口），实现完成并验证后应连同调用点一起删除；埋点默认写入 `%TEMP%` 下的 jsonl，不影响运行时行为。
- **文档跟进**：既有子智能体流式设计文档需要补一节说明「变体 B 的声明源是 `subAgentActivity`」，否则后续维护者会重复踩同一个坑。
- **协议版本**：结论基于 codex CLI 0.146.1（CodeMUX 托管 Runtime）。上游若改变声明源或线程归属，本 spec 的 D1/D2 应作为可扩展点（新增声明源即可，不改轨道与路由语义）。
