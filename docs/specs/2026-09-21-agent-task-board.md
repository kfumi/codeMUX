# 工作任务看板（Work Task）

**Status:** ready-for-agent

> 参考实现调研自 codeg（`codeMUX/codeg` 内嵌参考项目）的 Work Task 功能：其状态机词汇、看板四列聚合、拖拽语义与验收流被有意沿用。术语与 Scheduled Task（定时任务）族区分：本实体称**工作任务（Work Task）**，用户可见名称「待办」。

## Problem Statement

用户目前没有一个能「委派工作并追踪进展」的入口：

1. **委派动作没有落点**——用户想让智能体干一件具体的活（例如「给登录页加表单校验」），只能手动开会话、手动输入指令、手动记住做到哪了；干完之后改了什么、能不能合回主分支，全靠用户自己记。
2. **多任务无法并行**——同一项目上想同时推进几件事，只能开多个会话来回切换，改动互相干扰，没有「哪个任务改了哪些文件」的边界。
3. **状态不可见**——哪些活还没开始、哪些正在跑、哪些在等用户回复、哪些可以验收合并，没有任何一处汇总视图，只能在会话列表里翻找。
4. **验收闭环缺失**——agent 改完代码后没有「看改动 → 合并回去」的一条路，worktree、diff、合并全要手工 git。

用户希望像 codeg 那样：在一个工作看板上添加任务、一键委派给 agent 执行、以列的方式看各状态任务、在 review 后一键合并。

## Solution

在 Daemon 中引入 **Work Task（工作任务）**：一条绑定了项目、Agent Kind、Kind Model Selection 与任务指令的持久委派单元。用户在四列看板（待办 / 进行中 / 等你处理 / 完成）上管理任务；启动任务时 Daemon 建一个可见的 Session（可选 git worktree 隔离，默认开），把任务指令作为 User Message 注入，agent 的执行进度通过 Session 的 CodeMUX Event 流回写为任务状态；跑完进入 review，用户看改动统计后一键合并回基线分支或直接完成。任务与 Session 互相打通：从看板可跳进会话旁观、插话，会话就是任务的执行现场。

全部状态与数据由 Daemon 持有（ADR 0011 Daemon 权威），所有 Daemon Client（桌面 UI、Mobile Companion、CLI）经 Companion Server 的同一组 REST 端点读写，看板在任意客户端一致收敛。

## User Stories

1. As a 桌面用户，我希望在待办看板上快速添加一个任务（标题 + 任务描述），以便把要委派的活记录下来不丢失。
2. As a 桌面用户，我希望在创建任务时选择所属项目，以便任务落在正确的代码库上执行。
3. As a 桌面用户，我希望在创建任务时选择 Agent Kind 与 Model Provider / 模型，以便控制用哪种智能体、哪个模型来执行。
4. As a 桌面用户，我希望 worktree 隔离默认开启，以便任务默认不打扰我当前的工作区。
5. As a 桌面用户，我希望在创建任务时能取消 worktree 隔离，以便让 agent 直接在项目目录里干活（小改动不值得切分支时）。
6. As a 桌面用户，我希望勾选 worktree 时能修改基线分支（默认项目当前分支），以便决定 worktree 从哪里切、改动合回哪里。
7. As a 桌面用户，我希望在四列看板（待办 / 进行中 / 等你处理 / 完成）上总览全部任务，以便一眼看清每件事处于什么阶段。
8. As a 桌面用户，我希望看到底层精确状态的卡片徽章（排队中 / 准备中 / 执行中 / 等你输入 / 待验收 / 合并中 / 失败 / 已取消 / 已中断），以便理解任务为什么停在这一列。
9. As a 桌面用户，我希望通过拖拽把待办任务拖到「进行中」列来启动它，以便用最直觉的方式委派执行。
10. As a 桌面用户，我希望在待办列内拖拽排序，以便控制多个待办任务的启动顺序。
11. As a 桌面用户，我希望点卡片打开详情侧滑，以便查看任务的完整信息（指令、分支、时间线、改动摘要）而不离开看板。
12. As a 桌面用户，我希望从卡片一键跳进任务关联的 Session，以便旁观 agent 执行、中途插话补充需求。
13. As a 桌面用户，我希望在 agent 提出问题等待输入时任务进入「等你处理」列，以便知道该回去回复了。
14. As a 桌面用户，我希望侧边栏常驻显示「等你处理」数量徽章，以便不打开看板也知道有活等我验收。
15. As a 桌面用户，我希望在 agent 完成工作后任务自动进入 review 并显示改动统计（文件数 / +新增 / -删除），以便不打开 git 就知道工作量。
16. As a 桌面用户，我希望在 review 时看到 agent 的结果摘要，以便快速判断改动方向是否符合预期。
17. As a 桌面用户，我希望对 review 中的 worktree 任务一键合并回基线分支，以便验收后改动立刻生效。
18. As a 桌面用户，我想在合并时自定义提交信息，以便提交历史可读。
19. As a 桌面用户，我希望合并冲突时任务回到待验收并明确提示冲突，以便我决定手动处理或重来。
20. As a 桌面用户，我希望对改动为空（或不想合并）的任务「直接完成」，以便看板不卡在无意义的合并上。
21. As a 桌面用户，我希望在任务失败时看到失败原因（agent 报错 / 环境准备失败 / 已中断的区分），以便决定重试还是重来。
22. As a 桌面用户，我希望一键重试失败的任务且尽量续用原会话，以便 agent 带着上下文继续而不是从零开始。
23. As a 桌面用户，我希望对已取消或想重来的任务「重新开始」——重置 worktree 丢弃改动、打回待办，以便干净地从头再来。
24. As a 桌面用户，我希望随时取消一个进行中的任务且取消后保留 worktree，以便以后还能找回现场。
25. As a 桌面用户，我希望同一项目同时只有一个任务在执行、超出的自动排队，以便资源消耗可控、合并不打架。
26. As a 桌面用户，我希望排队中的任务在前一个结束时自动开始，以便扔进去的活不用我盯守。
27. As a 桌面用户，我希望按项目筛选看板，以便多项目混用时聚焦当前关心的库。
28. As a 桌面用户，我希望切换「看板 / 列表」两种视图且偏好被记住，以便任务多时用列表快速扫。
29. As a 桌面用户，我希望在列表视图按列（四列口径）筛选状态，以便只看某一类任务。
30. As a 桌面用户，我希望显示/隐藏已取消和已归档任务且被记住，以便看板默认干净但随时可回查。
31. As a 桌面用户，我希望归档已完成的任务并可一键「归档全部已完成」，以便看板不无限堆积。
32. As a 桌面用户，我希望取消归档恢复任务，以便误归档可找回。
33. As a 桌面用户，我希望彻底删除已终结的任务（删除前自动清理 worktree），以便永久清除不要的记录。
34. As a 桌面用户，我希望看板状态实时更新（我改一处，其他打开的客户端同步收敛），以便桌面与 Mobile Companion 看到一致状态。
35. As a 桌面用户，我希望待办 / 失败状态的任务可以编辑（改标题、指令、分支），以便启动前修正委派内容。
36. As a 桌面用户，我希望进行中的任务锁定编辑，以免中途改需求造成执行与记录不一致。
37. As a 桌面用户，我希望从侧边栏一键进入待办看板，以便把它当工作台用而不是藏在深处。
38. As a 桌面用户，我希望任务完成后记录「怎么完成的」（合并 / 直接完成），以便回查时有结论。
39. As a 移动伴侣用户，我希望在手机上查看与操作同一块看板，以便外出时仍能委派和验收。
40. As a 桌面用户，我希望任务产生的 Session 在会话列表里能找到，以便从任一入口都能回到执行现场。

## Implementation Decisions

**实体与命名**

1. 新领域实体 **Work Task（工作任务）**：绑项目、绑 Agent Kind 与 Kind Model Selection、携带任务指令，可驱动一次可见的 Session 执行。与 Scheduled Task 正交——后者是定时触发的 User Message 模板，前者是看板上的委派单元。代码与协议统一用 work-task 词根。
2. 状态机沿用 codeg 的 10 状态词汇：`todo → queued → preparing → running ⇄ awaiting_input → review → merging → done`，旁路 `failed / canceled`，外加 `archived_at` 软归档与 `failure_reason`（`agent_error` / `setup_error` / `interrupted`）。`run_seq` 代际号隔离每轮执行的事件回写。
3. UI 只讲四列（待办 / 进行中 / 等你处理 / 完成），由纯函数把 10 个状态聚合进列：`todo + queued → 待办`；`preparing + running → 进行中`；`awaiting_input + review + merging + failed → 等你处理`；`done + canceled → 完成`。**测试守卫：每个状态必须归属且仅归属一列，否则测试失败**——防止新增状态被看板静默吞掉。

**Daemon 存储层**

4. SQLite 新表 `work_tasks`：身份、项目（project_id）、标题、任务指令、Agent Kind、Model Provider / model 覆盖、worktree 开关与基线分支、状态、failure_reason、last_error、run_seq、sort_order（每项目启动队列序）、session_id（当前执行代际的 Session）、worktree 路径 / work_branch / base_branch、结果摘要、diff 统计（files_changed / additions / deletions）、merge 提交号、completion_kind（merged / completed_without_merge）、archived_at，以及 created / updated / started / settled / finished 时间戳。
5. 追加 `work_task_events` 时间线表（append-only），记录状态流转与动作（启动 / 取消 / 重试 / 合并 / 完成…），**与状态变更同事务写入**；详情侧滑的时间线从它投影。
6. 状态流转用 CAS 守卫（期望态不匹配即拒绝），非法流转对 API 返回明确错误。

**执行编排（Daemon 内）**

7. 启动 = claim：校验并发配额，`todo → queued → preparing`；preparing 阶段（勾选 worktree 时）用既有 git 能力从基线分支切 worktree 与 work 分支，随后在该目录创建 Session（项目路径指向 worktree），把任务指令作为 User Message 注入，进入 `running`。
8. 状态回写由 Session 事件驱动：Turn Outcome 正常结束 → `review`（回写结果摘要与 diff 统计，diff 按 work 分支对基线分支计算）；出现 Interactive Request（依据 ADR 0004 的策略）→ `awaiting_input`；Session 错误 → `failed`（区分 `agent_error` / `setup_error` / `interrupted`）；事件按 `run_seq` 匹配，过期代际的事件一律丢弃——这是取消后旧会话残留事件不会把任务拖回原状态的保障。
9. 并发上限按项目计算（首版默认 1，常量即可）：`running / preparing / merging` 占坑；任务到达终态或被取消时释放，并自动领取该项目队列中的下一个 `queued` 任务。
10. 重试：从 `failed` 续原 Session 发「继续」指令（会话不可续则新开 Session，worktree 与已有改动保留），`run_seq` +1。重新开始：仅对 `canceled`（或失败后明确重来）开放，把 worktree 重置回基线分支、丢弃改动，打回 `todo`。取消：立即生效，任务进 `canceled`，worktree 默认保留（卡片提示已保留）。

**验收与合并**

11. review 中的 worktree 任务可「合并」：Daemon 直接执行 git merge（work 分支 → 基线分支，提交信息用户可填，默认自动生成），全程 `merging` 状态；成功 → `done`（completion_kind = merged）并清理。冲突 → 回 `review` 并以 last_error 提示冲突需手动处理，**不引入 agent 代跑合并**。首版不做自动合并队列：同项目同时只允许一个任务处于 `merging`，其余任务此时合并按钮置为不可用。
12. 「直接完成」：改动为空或用户放弃合并时，worktree 任务结束为 `done`（completion_kind = completed_without_merge），worktree 可选清理；非 worktree 任务没有合并环节，跑完即 `review`，用户点完成即 `done`。

**Companion Server 协议**

13. REST 端点（wire 格式 camelCase，同 Scheduled Task 惯例）：`/work-tasks` 列表/创建、`/work-tasks/{id}` 读取/更新/删除，以及动作端点：start、reorder（每项目待办排序）、cancel、retry、requeue、merge、complete、archive、unarchive。
14. 每次任务变更广播低频 work-task 变更 nudge（经既有 Companion 事件通道）；客户端收到后 refetch 收敛（fire-and-refetch，同 codeg 的 task changed 事件模式）。Daemon Client（桌面、Mobile Companion、CLI）无差别适用，符合 ADR 0011 / 0012 的 Daemon 权威架构。

**前端（Desktop Shell 与 Mobile Companion 共用统一前端）**

15. 分层照 scheduled tasks 全链路惯例：领域类型、daemon facade 的 workTasks 命名空间、control-plane fetch 方法、zustand store（workTaskStore）。
16. 看板组件族建在 components 下的 worktask 目录：四列 board、任务卡片（状态徽章按视觉语义分型：进行中转圈、等你处理琥珀胶囊、完成绿勾、失败红胶囊、其余灰）、创建/编辑对话框、详情侧滑、列表视图。布局与交互移植 codeg 的 tasks 页骨架（四列 grid、卡片、portal 拖拽预览、drop 高亮、防误触点击 latch）。
17. 交互语义：卡片点击开详情；「查看会话」直接导航到会话视图（`view: 'app'` + 会话 id），返回栈回看板；拖拽语义 = 待办列内拖排序（持久化 sort_order）+ 拖到进行中列即启动。
18. 导航：navigation view 增加「待办」，侧边栏「待办」按钮（照「自动化」接线），懒加载看板面板；侧边栏「等你处理」徽章 = awaiting_input + review + failed 计数，数据源与看板共用一个常驻 provider。
19. 视图偏好（看板 ⇄ 列表、筛选开关）持久化到 localStorage，首帧同步恢复。

**UI 规范**

20. 全部遵循仓库外观规范：语义色 token（禁硬编码色值）、动态字号（text-ui-\* / text-code）、--radius 圆角、共享 TooltipHint、shadcn/ui 组件优先；例外仅限语义本身带色的内容（diff 红绿、状态点缀）。

## Testing Decisions

**好测试的标准**：只测外部可观察行为——给定输入 / 事件序列，断言 API 结果、任务状态、UI 呈现与回调；不断言实现细节（内部方法调用序、私有结构）。状态流转测试以「事件序列 → 状态时间线」表达，不 mock 内部中间层。

**Seam 1 — Rust 服务层（主接缝）**：work task service + db operations，对内存 SQLite。覆盖：建表与补列迁移、CRUD、CAS 状态流转守卫、每项目并发领取与排队（占坑 / 释放 / 自动领下一个）、run_seq 代际隔离（过期代际事件被丢弃）、仅终结态可删除与删除前 worktree 清理、会话事件 → 状态回写映射（用假 CodeMUX Event 序列驱动：Turn Outcome / Interactive Request / 错误 → 状态）。先例：db operations 与 daemon run state 的 `#[cfg(test)]` 直接对真实 SQLite 的写法。HTTP 路由层为薄 serde 壳，不单测（与 `/scheduled-tasks` 现状一致）。

**Seam 2 — 前端看板纯函数**：列聚合（含「每个状态必须归属某列」守卫断言）、列表过滤、显示已取消 / 已归档可见性、各状态动作可用性矩阵、合并可用性判断。先例：codeg 的 board-columns / task-acceptance 测试（随移植引入其测试矩阵的 codeMUX 版）。

**Seam 3 — 前端 store 接缝**：workTaskStore 对 stub facade 测 CRUD、动作调用后的乐观更新与 refetch 收敛。先例：agentStore 与 store-double-write 的测试。

**Seam 4 — 组件级（薄）**：任务卡片渲染与动作回调（Testing Library），只测行为。先例：McpSettings 测试。

**回归门**：受影响 vitest 文件随改随跑；提交前全量 vitest（根 + sidecar）+ cargo fmt / clippy / check + build daemon。

## Out of Scope

- **定时启动（scheduled_at）**：不给任务排启动时间；需要定时的活走 Scheduled Task。
- **自动合并队列**：不做多任务合并排队与自动放行；同项目串行合并（按钮置灰）已覆盖首版需求。
- **任务模板**：不做创建模板 / 从模板建任务。
- **任务级 Permission Snapshot / Plan Mode 覆盖**：权限档跟随该 Agent Kind 默认预设，不从任务表单设置。
- **无头后台执行**：不做脱离前台的执行宿主；任务一律绑定可见 Session。同一状态机下将来可加。
- **从会话反向建任务**（“从消息建任务”通道）：二期考虑。
- **「全部开始」批量启动**。
- **归档列表的堆积治理**（归档内搜索 / 批量清理）：归档本身在范围内，治理不在。
- **gemini_cli 等未接入的 Agent Kind**：随 Agent Kind 注册表自然获得，不单独适配。

## Further Notes

- codeg 的完整参考实现在 `codeMUX/codeg`（前端 tasks 组件族、后端 work task 命令与 engine），是移植骨架与状态机词汇的直接来源；但 codeMUX 不复制其 merge queue 的全部复杂度，首版按本 spec 的简化决策实现。
- `run_seq` 代际隔离是事件回写正确性的地基：凡涉及「取消后旧事件不得复活任务」的行为，都必须按代际匹配，这是 Seam 1 的必测项。
- 命名冲突说明：仓库领域词 Task 已被 Scheduled Task 族占用（Task Instruction / Task Run），故用户可见实体用「工作任务 Work Task」。
- 基线分支默认取项目当前分支；worktree 建立后把实际使用的分支记录在任务上（同 codeg 的 base_branch 落库语义）。
- 相关架构约束：ADR 0003（CodeMUX Event 统一协议，事件回写取自 Session 事件流）、ADR 0004（Interactive Request / Turn Outcome 策略，awaiting_input 的判定来源）、ADR 0011 / 0012（Daemon 权威与 Companion Server 协议入口）。
