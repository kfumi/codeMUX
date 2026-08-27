# 定时任务（Scheduled Task）

**Status:** ready-for-agent

Canonical design copy: [docs/superpowers/specs/2026-08-27-scheduled-tasks-design.md](../../docs/superpowers/specs/2026-08-27-scheduled-tasks-design.md)

## Problem Statement

用户希望 CodeMUX 能按时间自动跑编码智能体：例如每个工作日总结最近提交、周五写周报、定期检查未合并改动。今天只能自己坐在电脑前新建 Session、选项目、写指令、点发送。侧栏没有自动化入口，后端没有调度层，关掉主窗口后虽然进程还在托盘里，也没有人替用户发那条 User Message。

参考 ZCode 的「自动化 / 新建定时任务」和 Codex 的「已安排的任务」，用户需要：给任务起名、设计划、写指令、绑项目与模型，到点自动开一轮对话，并能在历史里看到每次执行、点进对应 Session。

## Solution

在桌面端增加「自动化」视图：落地页用模板降低空白成本，编辑页配置标题、计划、指令与运行上下文。每条 Scheduled Task 是持久定义，不是 Session。时钟在 Rust 里走，到期后创建一条普通 Session，把任务指令当 User Message 发出。对话、审批、通知、Companion 全部复用现有路径。

权限、模型与新建对话同一套控件、同一套默认值：打开「新建定时任务」时，指令区底部就有执行档位下拉（以及 Agent Kind / 模型 / 思考强度），预选该种类新建对话会用的 Permission Snapshot 和 Plan Mode（默认关）。用户可以当场把档位切成「变更前确认 / 自动改文件 / 全权限」等任一档再保存；保存的是这条 Scheduled Task 自己的快照，到点开火用这份，而不是每次再去读全局设置。不为定时任务另做一套更松或更紧的默认档，也不把下拉藏起来或锁死。定时任务只在 CodeMUX 运行时（含托盘）生效。

## User Stories

1. As a 桌面用户，我希望侧栏在「搜索」下方有「自动化」入口，以便与新对话平级进入定时任务，而不是钻进设置。
2. As a 桌面用户，我希望打开自动化后先看到任务列表和建议模板，以便知道系统能帮我定时做什么。
3. As a 桌面用户，我希望用搜索框过滤已有定时任务的标题，以便任务多了仍找得到。
4. As a 桌面用户，我希望右上角有「创建」按钮，以便从空白开始新建定时任务。
5. As a 桌面用户，我希望点「每日提交简报」模板后带出预填标题、工作日计划与任务指令，以便立刻改项目就能用。
6. As a 桌面用户，我希望点「每周回顾」模板后带出周五下午的计划与周报类指令，以便收一周工作。
7. As a 桌面用户，我希望点「跟进监控」模板后带出工作日早晨检查未合并改动的指令，以便催自己处理遗留项。
8. As a 桌面用户，我希望模板只预填文案和计划、不锁死项目和模型，以便落到我当前的仓库与默认智能体。
9. As a 桌面用户，我希望面包屑显示「自动化 > 新建任务」或「自动化 > {标题}」，以便知道自己在哪一层。
10. As a 桌面用户，我希望编辑页有「设置」和「历史」两个 Tab，以便改配置和看过去的执行分开。
11. As a 桌面用户，我希望任务标题默认为「未命名定时任务」，以便没想好名字也能先保存。
12. As a 桌面用户，我希望可以随时改标题，以便列表里认得出这条任务。
13. As a 桌面用户，我希望计划提供每小时、每天、每工作日、每周、每月，并选定本机时刻，以便覆盖常见节奏。
14. As a 桌面用户，我希望「每工作日」按周一到周五计算，以便周末不跑日报。
15. As a 桌面用户，我希望「每周」能选星期几，「每月」能选几号，以便对齐周会和月初检查。
16. As a 桌面用户，我希望计划按本机时区解释，以便 9:00 就是我电脑上的九点。
17. As a 桌面用户，我希望保存后能看到下次执行时间，以便确认计划没填错。
18. As a 桌面用户，我希望指令区是大文本框，占位示例是「总结最近 24 小时的提交，标出可能引入的 bug 和修复建议」，以便知道该写人话而不是 cron。
19. As a 桌面用户，我希望必须选择一个项目，以便智能体在正确的仓库 cwd 上跑。
20. As a 桌面用户，我希望没有项目时不能创建任务，并看到明确提示，以便先去添加文件夹。
21. As a 桌面用户，我希望 Agent Kind、模型、思考强度的默认值与新建对话相同，以便不用为定时任务重新想一套模型组合。
22. As a 桌面用户，我希望新建定时任务打开时，执行档位下拉已预选成与新建对话相同的 Permission Snapshot（设置里该种类的默认权限，Plan Mode 默认关），以便不用先改一档才能保存。
23. As a 桌面用户，我希望指令区底部能用与 Composer 同一套执行档位下拉当场切换权限，以便这条任务用「变更前确认」、另一条用「自动改文件」，不必改全局设置。
24. As a 桌面用户，我希望下拉切换后点保存，选中的 Permission Snapshot 写进这条任务，之后每次 Task Run 都用这份，以便不会在我改过全局默认后悄悄变档。
25. As a 桌面用户，我希望切换 Agent Kind 时权限下拉回到该种类的新建对话默认，与草稿会话切换种类的行为一致，以便不跨种类硬译权限枚举。
26. As a 桌面用户，我希望空指令不能保存，以便不会到点发出空白 User Message。
27. As a 桌面用户，我希望保存后任务默认启用，以便创建完就开始按计划跑。
28. As a 桌面用户，我希望列表上能开关启用，以便出差停几天不必删任务。
29. As a 桌面用户，我希望禁用后不再触发新的 Task Run，已在跑的那次不受影响，以便停任务不等于杀当前对话。
30. As a 桌面用户，我希望能删除定时任务，以便去掉不再需要的计划。
31. As a 桌面用户，我希望删除任务不删除它已经创建的 Session，以便历史对话还在项目分组里。
32. As a 桌面用户，我希望到点后自动新建一条 Session 并发送任务指令，以便每次执行的历史彼此独立。
33. As a 桌面用户，我希望这条 Session 出现在对应项目下，并带「定时」来源标记，以便和手聊区分。
34. As a 桌面用户，我希望 Session 标题能看出是哪条定时任务、哪一次执行，以便侧栏里扫一眼能认。
35. As a 桌面用户，我希望 Task Run 发出的指令在时间线里就是普通 User Message，以便可以像手聊一样续写、审批、Fork。
36. As a 桌面用户，我希望应用在托盘或失焦时，定时任务完成、失败或等待输入仍走现有系统通知，以便不盯着窗口。
37. As a 桌面用户，我希望点通知会打开窗口并切到那条 Session，以便接着审批或阅读结果。
38. As a 桌面用户，我希望若权限档会停在 Interactive Request，任务就停在那里等我，不要自动批准，以便和手聊同一条审批语义。
39. As a 桌面用户，我希望等待审批时历史里该次执行为「等待输入」，以便知道不是死掉了。
40. As a 桌面用户，我希望同一条任务上次还在跑或还在等我时，本次到期会跳过并记原因，以便同一仓库不会并行开两个 sidecar。
41. As a 桌面用户，我希望应用退出期间到期的计划在重新打开后不一次性补跑，以便挂一晚不会连开十几轮。
42. As a 桌面用户，我希望漏跑后只计算下一次执行时间，并可在界面上理解「应用没开所以没跑」，以便不误以为调度坏了。
43. As a 桌面用户，我希望自动化页顶部说明「仅在 CodeMUX 运行时（含托盘）生效」，以便知道彻底退出就没有闹钟。
44. As a 桌面用户，我希望关闭主窗口到托盘后定时任务仍会触发，以便不把窗口开在前台也能跑。
45. As a 桌面用户，我希望 Turn Outcome 失败或空闲超时时，该次执行记为失败且 Session 保留，以便我可以进去重试，调度器不要自己连环重试。
46. As a 桌面用户，我希望历史 Tab 列出每次执行的时间、状态、关联 Session，以便审计。
47. As a 桌面用户，我希望点历史中的一行就打开对应 Session，以便直接看输出。
48. As a 桌面用户，我希望跳过的执行也出现在历史里并写明原因（重叠 / 并发上限），以便排查「今天怎么没跑」。
49. As a 桌面用户，我希望改指令或计划只影响以后的 Task Run，不影响已经在跑或已经结束的 Session，以便历史不被改写。
50. As a 桌面用户，我希望项目被删后相关定时任务不能再开火，并在列表上标明项目不可用，以便避免对消失的路径起 sidecar。
51. As a 系统维护者，我希望调度权威在 Rust 而不是前端定时器，以便窗口隐藏或节流时仍能到期触发。
52. As a 系统维护者，我希望 Task Run 复用 Companion 已有的「后端创建 Session 并发送」路径，以便不把 `startQuery` 绑成唯一入口。
53. As a 系统维护者，我希望 Scheduled Task 模块对外只有任务 CRUD、启用开关和 `tick`，以便测试不必起 sidecar。
54. As a Mobile Companion 用户，我希望首版仍能打开定时任务创建出来的普通 Session、跟流和审批，以便人在手机上也能处理「变更前确认」。
55. As a Mobile Companion 用户，我希望首版不在手机上创建或编辑定时任务，以便调度权威仍只在桌面。
56. As a 桌面用户，我希望未配置 Provider Credentials 时到期执行失败并记入历史，而不是静默跳过，以便知道要去补 API Key。
57. As a 桌面用户，我希望全局限流：过多定时任务同时到期时超出的记跳过，以便机器不被打满。
58. As a 桌面用户，我希望从列表点进已有任务就是编辑页而不是再新建，以便改一条指令不必重建。
59. As a 桌面用户，我希望「每小时」不要求选时刻，在每个整点触发，以便配置更短。
60. As a 桌面用户，我希望保存非法计划（例如每月 31 号在没有 31 号的月份）时有确定行为：该月跳到最后一天或跳过该月，并在下次时间上反映出来，以便不会 silently never run。
61. As a 桌面用户，我希望创建中的草稿离开自动化视图前提示未保存（若有未保存变更），以便误点侧栏不丢指令。

## Implementation Decisions

### 产品范围（一期）

- 桌面「自动化」视图：落地页（搜索、模板、任务列表）+ 编辑页（设置 / 历史）。
- 每条 Scheduled Task 一条 Schedule；预设为每小时、每天、每工作日、每周、每月；时刻为本机本地时间。
- Run Delivery 仅 `new_session`。
- 漏跑不补跑；同任务重叠则 skip；调度器不自动重试失败。
- 应用必须在运行（含托盘）；不做 OS 级计划任务。

### 调度权威

- 时钟与开火在 Rust 的 Scheduled Task 模块。前端只做 CRUD 与展示。
- 进程启动后周期性调用 `tick`（约 30 秒一拍即可；到期判断以 `next_run_at <= now` 为准，不依赖拍子对齐整点）。
- 不把 cron 放进 sidecar：sidecar 按 Session 拉起，不是全局常驻调度器。
- 不在 React 里用 `setInterval` 当闹钟。

### 与现有领域对象的关系

- Scheduled Task 持有自己的 Permission Snapshot 与 Kind Model Selection。创建/编辑页用与新建对话 Composer 底部同一套执行档位下拉；打开表单时预选新建对话默认，用户可下拉改档后保存。Task Run 创建 Session 时把任务上这份已保存快照抄进去，之后这条 Session 就是普通 Session：用户可再改权限、切 Agent Kind、发后继 User Message。
- 默认值来源与新建对话相同：该 Agent Kind 在应用设置 `agent_configs` 中的默认 Permission Snapshot；没有则回落到种类内置默认。Plan Mode 默认 `off`。模型回落 Active Provider 的默认模型。不为定时任务设置更松的 `full_access` 或更紧的只读默认，也不隐藏或禁用执行档位下拉。
- 开火时读任务上已保存的快照，不在 `tick` 时重新绑定全局 `agent_configs`。用户若只改设置里的默认权限，已保存的定时任务档位不变。
- Task Instruction 发出时就是 User Message，进入该 Session 的 CodeMUX Event 时间线。
- Task Run 不是 Queued Message，也不是 Immediate Run。若目标 Session（续聊二期）当时正忙，一期不存在该问题，因为每次新建 Session。
- Interactive Request 语义不变（含 ADR 0004：审批默认无限等待；空闲守卫在等待人类时挂起）。

### 模块接口

Scheduled Task 模块是这一功能的唯一致深模块。调用方只需学会：

- 创建 / 更新 / 删除任务
- 启用 / 停用
- 列出任务与某任务的 Task Run
- `tick(now)`：把所有到期且可开火的任务变成 Task Run

实现对外隐藏：下次时间计算、工作日/月末规则、重叠与全局限流、漏跑丢弃、Session 引导、失败记账。

内部两个 adapter，只为测试可替换，不是第二套产品接口：

- **Clock**：读当前时间。
- **TaskRunner**：给定任务快照，创建 Session 并发送 Task Instruction；报告 Turn 结束或进入等待输入。生产适配器走与 Companion 相同的会话生命周期入口。

`tick` 对同一任务必须幂等：`next_run_at` 未到不重复开火；开火后立即把 `next_run_at` 推到下一档，即使 runner 还没结束。

### 概念形状

```typescript
type ScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
type RunDelivery = 'new_session'; // 一期仅此值
type TaskRunStatus = 'running' | 'completed' | 'failed' | 'awaiting_input' | 'skipped';

interface ScheduledTask {
  id: string;
  title: string;
  instruction: string;
  projectId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionConfig: AgentPermissionConfig;
  planMode: AgentPlanMode;
  scheduleKind: ScheduleKind;
  scheduleTime: string; // "HH:mm" 本地；hourly 可忽略
  weeklyWeekday: number | null; // 0-6，仅 weekly
  monthlyDay: number | null; // 1-31，仅 monthly
  timezone: string; // 保存时的本机时区标识
  delivery: RunDelivery;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: TaskRunStatus;
  skipReason: 'overlap' | 'concurrency_limit' | 'project_missing' | null;
  error: string | null;
}
```

月末：`monthlyDay` 大于该月天数时，落在该月最后一天（31 → 2 月 28/29）。

### 持久化

- 新增 `scheduled_tasks` 与 `scheduled_task_runs` 两张表。不把计划塞进 `sessions` 行。
- Session 用来源标记区分定时创建（扩展现有 origin，或等价的轻量来源字段），以便侧栏打标。删除任务时 Session 保留，Run 记录可随任务级联删除或保留为悬空（一期：Run 随任务级联删除，Session 保留）。
- `project_id` 外键：项目删除时任务停用并在列表标「项目不可用」，到期 skip（`project_missing`），不级联删任务，避免用户丢指令。

### IPC 与导航

- 前端经 Tauri command 做任务 CRUD、启用、列表与历史；不把 `tick` 暴露给前端。
- 导航增加自动化视图（与 `app` / `settings` 并列），进入后主栏渲染自动化落地页或编辑页，而不是 AgentPanel。
- 从历史打开 Session：切回 `app` 视图并选中该 `sessionId`。

### UI

- 落地页学 Codex：搜索、创建、建议模板、任务列表（标题、下次时间、启用开关、最近状态）。
- 编辑页学 ZCode：标题、计划、指令大文本；底部复用项目选择器、执行档位下拉、Agent Kind / 模型 / 思考强度选择器。执行档位下拉在新建时即可切换，不是只读展示。
- 一期不展示「续写上次对话」。高级去向留到二期。
- 模板预填不写入数据库，直到用户点创建/保存。

### 通知

- 不新增通知种类。定时任务创建的 Session 走现有 `requires_input` / `task_completed` / `task_failed`。
- 通知标题带任务标题，便于和手聊区分。

### 并发

- 同任务：已有 `running` 或 `awaiting_input` 的 Run → 新到期 skip（`overlap`）。
- 全局：同时进行的定时 Task Run 上限为 2；超出 skip（`concurrency_limit`）。手聊 Session 不计入该上限。

### 生命周期文案

- 自动化视图顶部常驻说明：定时任务仅在 CodeMUX 运行时生效（包括隐藏到托盘）；彻底退出后不会触发，也不会在下次启动时补跑。

## Testing Decisions

好的测试只断言模块对外行为：给定任务表与时间，`tick` 之后出现了哪些 Task Run、Runner 被叫了几次、`next_run_at` 挪到了哪里、哪些被 skip。不断言 tokio 怎么排、SQL 语句长什么样、前端 store 内部字段。

**唯一测试缝：Scheduled Task 模块接口（CRUD + `tick`）。** Clock 与 TaskRunner 用测试 adapter 注入。这是最高缝：到期、重叠、漏跑、权限快照抄进 Session 引导载荷，都从这里观察。不要再为 cron 解析、IPC、sidecar 各开一条对等缝。

覆盖：

- 启用任务在 `next_run_at` 到期时创建 Run，Runner 收到的引导载荷含项目、Agent Kind、与任务相同的 Permission Snapshot / Plan Mode / 模型，以及作为 User Message 的任务指令。
- 权限默认：新建任务未改执行档位时，快照与同种类新建对话默认一致（设置中的 `agent_configs`，否则种类内置默认）；Plan Mode 为 `off`。
- 权限保存：创建时把下拉改成另一档再 upsert，随后 `tick` 交给 Runner 的是改过的那份快照，不是全局默认。
- 未到期的 `tick` 不调用 Runner。
- 同任务重叠 skip，且 `next_run_at` 仍前进。
- 应用「关机」期间跨越多个计划点后，下一次 `tick` 只开一轮（或不补历史点，只对准下一个未来点），不补开 N 轮。
- 禁用 / 删除 / 项目缺失的任务不开火。
- 全局并发上限导致 skip。
- 每月 31 号在短月落到月末。
- 工作日计划在周六日的 `tick` 不开火。

前端：自动化列表/编辑器的组件测试只覆盖用户能看见的状态（空状态模板、必填校验、开关、点历史跳转、执行档位下拉可切换且随保存提交）。不在组件测试里模拟时钟。

先验：Companion 的后端发消息路径测试、新建会话权限默认测试（`newSessionStore` / `agentPermissions`）、系统通知候选分类测试。TaskRunner 生产适配器应薄到几乎不必单测；行为由 Scheduled Task 模块 + 既有会话生命周期测试分担。

## Out of Scope

- 自定义 cron、同一任务多条计划。
- Run Delivery 为续写上次 Session。
- 漏跑补跑、失败自动重试。
- 文件变更、git 钩子、webhook 等非时间触发。
- OS 级计划任务、应用退出后仍触发。
- 邮件、日历、跨设备推送、独立通知历史中心。
- 工作流画布、多步骤编排。
- 移动端创建/编辑/开关定时任务。
- 为定时任务单独做比手聊更松的自动写盘默认，或强制只读默认。
- 隐藏或锁死新建任务页的执行档位下拉。
- Plan Mode 在定时任务上默认开启或自动 Implement。
- `gemini_cli`。

## Further Notes

- 二期若做续写 Session：需定义目标 Session 忙碌时是排队、skip 还是新建；那会碰到 Queued Message，不要在一期预埋半成品。
- 二期若做自定义 cron：仍由 Scheduled Task 模块消化表达式，UI 不要把 cron 字符串散落到多个调用方。
- 月末与时区规则一旦实现，只准改模块内部；调用方只认 `next_run_at`。
- 与 ADR 0004、0008 相容：无人值守不等于自动批准；移动端仍是桌面伴侣，调度不能搬到手机。

## Comments

- 权限默认已按产品确认修正：与新建对话相同，不另设「变更前确认」或 `full_access` 专用默认。
- 新建/编辑页必须提供与 Composer 同一套执行档位下拉：预选默认、可当场切换、保存到该 Scheduled Task；开火读任务上的快照，不回绑全局设置。
