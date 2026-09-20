# 02 — 变体 B 打通：派生即建轨道，父卡片可点进面板

**What to build:** 在「agent path / 父历史 fork」这种 Codex 协作变体下（今天整支静默：没有卡片、没有轨道内容），用户派生子智能体后能在父对话看到一张可点击的委派卡片，点进去看到该子智能体的**实时推理、助手消息与工具调用**；先于声明到达的子线程通知在声明登记后按序补齐；同一个派生被重复宣告只产生一张卡片与一条轨道；子智能体被中断显示为已取消而不是一直运行中；同批派出的多个子智能体各有各的卡片与轨道，卡片上能显示名字与 agent 路径以便区分；完成后卡片状态收敛为已完成。变体 A 行为零回归。

**Blocked by:** 01 — 子智能体声明收紧：只有派生调用能建轨道（同一条声明分支的 prefactor；先收窄语义，才能判断「真的有轨道了吗」）

**Status:** ready-for-agent

- [x] 父线程收到子智能体活动声明（`subAgentActivity`，`kind=started`）时即建立轨道并登记该子线程的路由，不再要求先出现派生的工具调用条目。
- [x] 被登记的轨道 id 与该次派生的 call id 一致，两种变体下语义统一；前端按 toolCallId 关联卡片与轨道的既有逻辑无需分叉。
- [x] 父时间线出现与变体 A 同形的委派卡片（同一工具名、同一 tool_use_id），点击可打该子智能体的预览面板；卡片状态随轨道状态收敛（运行中 / 已完成 / 失败 / 已取消）。
- [x] 子线程的推理增量、助手消息、工具生命周期与终态都投影进该轨道；声明登记后立即回放此前缓冲的通知，顺序与到达顺序一致。
- [x] 同一 call id 的重复宣告（含 started 与 completed 两条同 kind=started 的记录、以及带线程 id 的二次宣告）只产生一条轨道、一次卡片、一次提示。
- [x] `kind=interrupted` 映射为取消；`kind=interacted` 不新建轨道也不改状态。
- [x] 标题取 agent 路径末段、副标题取完整 agent 路径；昵称可用时优先昵称；两者都缺时沿用既有「未命名子智能体」回退。
- [x] 卡片输入不编造内容：变体 B 拿不到任务原文时只带 agent 路径，任务文本由子线程自己的入站消息在轨道里呈现。
- [x] 单测（状态机 seam）覆盖：变体 B 父路由声明、重复宣告幂等、pending 回放顺序、中断→取消；用例输入取自真实 wire 快照。
- [x] 端到端（假 app-server seam）新增一条变体 B 通知序列，断言父卡片事件与轨道事件都出现且内容正确。
- [x] 没有子智能体的普通会话不产生任何子智能体事件；既有测试全绿，Sidecar 构建通过。

**Outcome（2026-09-19）:** 完成。`CodexSubagentSource.observeActivity` 成为与 collab spawn 并列的声明例程（规范 id = `subAgentActivity.id`、路由键 = `agentThreadId`、`title`/`subtitle` 取 agent 路径、登记后立即回放 pending）；`claudeSubagentFold` 的 `declared` 观察支持 `subtitle`；运行时用新增的 `activityDeclaration()` 查询合成同形父卡片（工具名 `subagent`、`tool_use_id` = 声明 call id、input 只带 `agent_path`），并在父/子路由都按“先读声明、再观察”的顺序保证只出一次卡片。
