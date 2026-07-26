# ADR-0001: Turn Artifact via Git Tree Baseline

## Status

Accepted

## Context

codeMUX 接入 Claude Code / Codex / OpenCode 三种 Agent，需要在对话完成后统一展示本轮产物：改动文件列表、+/- 行数、可审查 Diff、可撤销。

工具事件（Write/Edit/apply_patch 等）在三种 Agent 上不一致，且无法覆盖 shell 等间接改文件路径。现有会话级 `changedFiles` 主要服务 Claude 工具面，不足以作为跨 Agent 权威来源。

仓库已具备 Git 工作区对比能力：`get_git_changed_files(projectPath, baselineTree)`（temp index + `add -A` + diff against baseline tree），以及 Review 面板的还原能力。

## Decision

1. **数据来源**：采用工作区基线对比（Workspace Baseline Compare），不以 Agent 工具事件作为权威产物来源。
2. **Baseline 实现**：Git temp-index `write-tree` 得到 Git Tree Baseline；Turn 结束后复用现有 `get_git_changed_files` 生成 Turn Artifact。
3. **非 Git 项目**：第一期降级为不展示产物总结。
4. **挂载粒度**：产物总结按 Turn 挂到对应 assistant 回复下，而非 Session 累计条。
5. **生命周期触发**：在用户发送 / `startQuery` 时采集 Git Tree Baseline（await 成功后再 dispatch Agent）；仅在 Turn **正常完成**后异步生成 Turn Artifact。用户中断、错误终止 **不生成、不展示** 产物卡。
6. **标识与持久化**：
   - 运行中使用客户端 `turn_id` 关联 baseline / 生成中状态 / UI 挂载。
   - SQLite 主键业务键为 `app_session_id + turn_ordinal`。
   - **`turn_ordinal` 仅在正常完成写 artifact 时计算**：值为该会话 **agent history 中 user 消息的 1-based 序号**（与历史重载同源）。取消/失败 **不占号**。
   - 不得用「当前 UI 乐观 user 条数」作为持久化序（发送后立刻取消可能导致 UI 有 user、history 无 user，重载会错位）。
7. **Rewind**：回退时删除 `turn_ordinal >= 回退点` 的 artifacts，避免幽灵/重复展示。
8. **取消后的乐观 user**：第一期允许保留在 UI（R1）；持久化序不计数这些未入 history 的消息。
9. **持久化内容粒度（S2）**：Turn Artifact 在 SQLite 中保存摘要 + 每文件 `original`/`current` 文本快照（以及 status、+/-）。历史重开展示的是**该轮结束时**的 Diff，不依赖事后磁盘状态。二进制或超大文件可只存路径/status，不内联全文。
10. **撤销语义（U2，整轮）**：Artifact Summary Card 的“撤销”一次处理本轮全部文件，不提供单文件撤销。Rust 对每个文件执行幂等 compare-and-write：当前等于 artifact.current 时恢复 artifact.original（added → 删除；deleted → 写回）；当前已等于 original 时视为已恢复；其它内容视为冲突。整轮成功后整张卡标记 `reverted`，仍可查看原始 Artifact Diff。禁止用相对 HEAD 的 `git restore` 冒充 Turn 撤销。第一期不做单文件撤销。
11. **零改动（E1）**：`filesChanged === 0` 时不渲染 Artifact Summary Card（可不持久化 empty 行，或持久化但不展示）。忽略规则跟随 Git 标准（`.gitignore` / exclude-standard）。
12. **Baseline 采集失败（F1）**：采集失败或超时（建议默认约 5s）时本轮不生成产物卡，**不阻断** Agent 发送/执行；记录日志。非 Git 与此同类降级。
13. **Diff 展示（D2）**：Artifact Summary Card 展开后只列文件路径与 +/-；点击文件打开现有 Preview Diff 面板（`openFile(path, originalFromArtifact)`），不在卡片内嵌大段 Diff，不新建 Modal。
14. **执行分层（L1）**：Rust 负责 `capture_workspace_baseline`、`build_turn_artifact`（对比 + 行统计 + 文本快照）、agent history user 计数与 SQLite 持久化/GC；前端在 `startQuery` / 成功完成钩子中编排调用并挂载 UI。成功完成信号：`result && !is_error` 且非 `forceStopped`（与 token usage 刷新同级触发）。
15. **序号权威（O3）**：成功完成时由 Rust 轻量扫描对应 Agent history，只统计 user 消息，得到当前 1-based `turn_ordinal`；不依赖 UI 列表或 artifact 数量。零文件成功 turn 不写 Artifact Card，但仍占 history 序号空间。
16. **SQLite 结构（DB2）**：第一期使用单表 `turn_artifacts`；每轮一条记录，文件列表、摘要、before/after 快照和整轮撤销状态统一存 `summary_json`。暂不拆 `artifact_files` 子表；整轮撤销通过事务读改写整份 JSON。
17. **撤销后展示（V2）**：整轮撤销成功后 Artifact Summary Card 保留原始文件列表与原始改动总计，整张卡标记 `reverted`；不把撤销误呈现为 Agent 从未修改过。
18. **历史加载与 Rewind（H3）**：Rewind 成功后立即 GC 删除 `turn_ordinal >= cutoff` 的 artifacts；历史加载时再读取当前 Agent history user 数 `N`，仅加载 `turn_ordinal <= N`，并且只挂到实际存在的正常完成 assistant turn。SQLite 是持久化缓存，当前 Agent history 是会话存在性的权威来源。
19. **历史加载时机（A1）**：`loadSessionMessages` 读取 Agent history 时，同步/并行调用 `load_turn_artifacts(sessionId)`；Rust 查询完成 H3 过滤后一次返回，前端一次性放入 store 并按 turn 序挂载，避免卡片与消息长时间错位。
20. **有效用户序（C2）**：`turn_ordinal` 只统计 Agent history 中的真实用户输入 turn；排除 tool result、compact、Task notification、仅 transcript 展示等内部 `user` 事件。Rust 计数器与前端 `isHiddenAssistantThreadUserEvent` 的语义必须对齐。
21. **Turn 边界权威（C2-B）**：Rust 在读取/解析 Agent history 时输出标准化 turn 元数据（至少 `turn_ordinal`、是否 `is_effective_user_turn`）；前端不再按事件数组位置自行推断产物序。完成时 Rust 返回本轮 `turn_ordinal` 与 Artifact；历史事件携带同一序号，前端按 metadata 绑定。
22. **完成接口（R1）**：新增独立 `build_turn_artifact` Rust command。前端仅在成功完成钩子调用，传入 `sessionId`、`projectPath`、运行态 `turnId`、`baselineTree`；Rust 计算有效 `turnOrdinal`、对比生成 S2 快照、事务写库并返回 Artifact/null。按 `(appSessionId, turnOrdinal)` 幂等 upsert，避免重复完成事件产生重复卡片。
23. **Baseline API（BAPI-1）**：新增独立 `capture_workspace_baseline(projectPath) -> treeHash|null` command。发送前由前端 await 调用；Rust 使用唯一临时 index 执行 `add -A` + `write-tree`，不修改用户 index/worktree；前端保存 `{turnId, baselineTree}`，完成时显式传给 R1 command。失败返回 null，Agent 仍继续执行。
24. **并发工作区修改（X1）**：Artifact 表示从发送前 baseline 到 Agent 正常完成期间工作区的最终变化，接受期间用户/其他进程改动可能混入；不尝试做进程来源归因或锁定工作区。
25. **大/二进制文件（SIZ1）**：按 UTF-8 字节数限制单文件快照为 `1 MiB`。文本且不超过上限保存 `original/current`；二进制或超限文本只保存路径、status、+/- 与 `content_available=false` / omitted reason。此类文件仍列在卡片，但 Preview 内联 Diff 与 Safe File Revert 禁用并显示原因。
26. **Safe Turn Revert 接口（RV1）**：新增独立 Rust command，参数为 `artifactId`，Rust 从 Artifact 记录解析项目根、全部文件快照和状态，执行路径安全校验、整轮 compare-and-write，并更新 `summary_json.reverted`。前端不传绝对路径或快照内容；不提供单文件撤销接口。
27. **撤销失败与幂等（RF2）**：Rust 为整轮文件操作提供进程内短锁和原子替换。执行前预检查全部文件：每个文件必须有完整快照，且当前等 `artifact.current` 或已等 `artifact.original`；任一文件冲突、无快照、路径异常或不可恢复时，整轮不写任何文件、不更新 `reverted`，返回具体失败文件。全部通过后再执行恢复；数据库更新失败时允许安全重试。
28. **前端状态索引（ST1）**：前端使用 `artifactsBySession: Record<appSessionId, Record<turnOrdinal, TurnArtifact>>`。运行态 `turnId` 仅关联 baseline/完成请求；完成返回的 `artifactId + turnOrdinal` 写入 ST1。历史加载、Rewind GC、整轮撤销均按 session + ordinal 更新。
29. **历史事件元数据（META1）**：Rust 标准化历史输出时，为所有属于有效 turn 的事件补 `turn_ordinal`；真实用户事件额外标记 `is_effective_user_turn=true`，内部 user 不标记/标 false。历史 assistant/result 可直接按该字段关联 Artifact。实时 sidecar 事件不要求即时带 ordinal，正常完成返回后由前端建立 `turnId -> turnOrdinal`。
30. **Artifact 生成 UI（UI2/SYNC2）**：Agent 回复在正常成功结果时立即结束；完成处理流程随后 `await build_turn_artifact`。有文件变化时返回后直接挂入对应 final assistant；零改动、baseline 失败或生成失败不留下卡片。
31. **文件行操作（ROW1）**：展开后的文件行只显示路径、status、+/-、打开 Preview Diff；撤销只提供卡片级整轮操作，不增加文件级撤销、独立审查/复制路径等操作。`reverted` 或无内容快照时由卡片级撤销规则处理，Rust 冲突错误转为明确提示。
32. **卡片默认状态（CARD1）**：Artifact Summary Card 默认折叠；折叠态显示本轮原始文件数与 +/-，以及整轮已撤销状态；展开状态仅为 UI 临时状态，不写 SQLite。
33. **Artifact Diff 预览（DIFF1）**：扩展 `previewStore.openFile`/`OpenFile` 支持 Artifact 来源和完整 `originalContent/currentContent` 快照。`source === 'artifact'` 时 Preview 直接使用持久化快照，不重新读取当前磁盘；超限/二进制无快照时禁用打开。
34. **整轮撤销后展示（AFTER1）**：整轮撤销成功后保留完整 Artifact Summary Card、文件列表和原始 Diff；卡片顶部标记“已撤销”，整轮撤销按钮禁用；`summary_json.reverted=true` 持久化，历史重开仍显示该状态。
35. **整轮撤销入口（UNDO1）**：撤销按钮位于卡片头部右侧，折叠/展开均可见。正常态点击弹确认；确认后显示处理中；成功变为“已撤销”并禁用；失败显示具体冲突文件/原因，不改变 Artifact 状态。
36. **项目路径固化（PATH1）**：`startQuery` 使用的 `cwd` 是本轮唯一项目根；baseline、Agent 执行、Artifact 生成、Diff 打开与撤销均使用该路径。`turn_artifacts.project_path` 持久化该值，不读取完成时的 active project/preview path。
37. **完成后处理时序（SYNC2）**：收到正常成功结果后，先将助手回复和 Agent turn 标记完成，再在同一完成处理流程中 `await build_turn_artifact`。有改动时返回后写入 ST1 并显示卡片；无改动/失败不显示。Artifact 后处理失败不得回滚 Agent 完成状态。
38. **Artifact 后处理失败（FAIL1）**：Artifact 生成、history 计数或 SQLite 写入失败时静默降级：不展示卡片、不重试、不阻断后续对话；记录带 `sessionId/turnId/projectPath` 的日志。用户仍可通过现有 Git Review 查看当前工作区。
39. **数据库迁移（MIG1）**：在现有 `db::schema::initialize_database` 初始化批次中加入 `CREATE TABLE IF NOT EXISTS turn_artifacts`、唯一约束 `(app_session_id, turn_ordinal)` 与 session 索引；老数据库启动时自动获得空表，不引入独立 schema version。
40. **数据清理（GC1）**：`turn_artifacts.app_session_id` 外键引用 `sessions(id) ON DELETE CASCADE`。删除 session 自动删除其全部 Artifact；删除项目沿现有 project → sessions 流程级联，不保留独立 Artifact 或外部快照文件。
41. **Rewind cutoff（RW1）**：`rewind_agent_session` 成功裁剪 Agent history 后返回标准化 `cutoffOrdinal`；前端使用该值调用 Artifact GC，删除 `turn_ordinal >= cutoffOrdinal` 的记录。前端不根据 UI events 自行计算 cutoff，避免乐观 user/内部 user 导致边界错误。
42. **Rewind GC 失败（RGC1）**：Agent history 已回退但 Artifact GC 失败时，rewind command 返回错误；前端清理当前 session 内存 Artifact 并重新加载 history/artifact，H3 过滤超出当前有效 user 数的记录。下次打开或再次 rewind 可重试 GC；不静默报告完整成功。
43. **整轮撤销返回（RET1）**：`revert_turn_artifact(artifactId)` 返回结构化联合：`{ status: 'reverted', artifact }` 或 `{ status: 'conflict', conflicts: [{ path, reason }] }`。成功时 Rust 已完成全部文件恢复与 DB 状态更新；冲突时预检查保证零文件写入、Artifact 状态不变；invoke 异常由前端按普通错误处理。
44. **快照编码（ENC1）**：`summary_json` 中 `original/current` 直接保存 UTF-8 JSON string，由 Rust `serde_json` 负责转义/序列化/反序列化；不做 Base64 或压缩。二进制/超限文件不存全文，使用 `content_available=false` 与 omitted reason。
45. **JSON 版本（VER1）**：`summary_json` 顶层固定 `schemaVersion: 1`。读取按版本解析；缺少可选字段使用默认值；未知版本跳过该 Artifact 并记录日志，不阻塞会话历史加载。数据库表版本与 JSON 版本独立。
46. **ID 生成（ID1）**：`artifactId` 由 Rust 使用 UUID 生成并作为数据库主键；客户端 `turnId` 作为可选追踪字段保存/记录日志，不承担历史绑定或唯一性。业务唯一约束仍为 `(app_session_id, turn_ordinal)`。
47. **项目路径失效（PATHFAIL1）**：Artifact 仍展示历史卡片和可用的持久化 Diff；若 `project_path` 不存在、不可访问或无法校验为原项目根，整轮撤销禁用并显示路径不可用原因。不隐藏 Artifact，不自动猜测或重绑定新路径。
48. **路径恢复探测（PATHREC1）**：加载会话/刷新 Artifact 时重新探测并显示撤销可用性；路径暂不可用时禁用撤销，恢复后可重新启用。点击撤销时 Rust 必须再次校验路径和完整预检查，UI 状态不作为安全依据。
49. **历史标准化位置（NORM1）**：Rust 直接在三个 `load_*_session_events` 路径中补齐 `turn_ordinal` / `is_effective_user_turn`；实时 sidecar 事件保持现状，正常完成时由 Rust Artifact command 返回本轮 ordinal。三种 Agent 的有效 user 识别规则集中在 Rust 历史解析侧。

## Consequences


- 三种 Agent 的最终文件影响展示同源、实现路径统一。
- 依赖项目为 Git 仓库；非 Git 场景暂无产物卡。
- Baseline 采集失败/超时采用 F1：对话优先，本轮无产物卡。
- 中断/失败 turn 若已写盘，不会出现产物卡（产品接受该缺口；用户可走 Git Review 面板处理）。
- 完成时需要能读取 agent history 的 user 序（或等价权威计数）以写入 `turn_ordinal`。
- Rewind 必须与 artifact GC 联动。
- Artifact 体积随改动文件全文增长；需对二进制/超大文件降级为仅元数据。
- 撤销依赖快照比对当前磁盘；后续人工/其它 turn 修改会阻止安全撤销（符合预期）。
- 二进制/超限文件只可查看元数据，不能内联 Diff 或 Safe File Revert。
- 新增 Rust commands + DB 表；前端 store 只保留 turn 运行态与按 session 索引的 artifact 视图。
- DB2 便于第一期快速落地，但按文件查询/局部更新能力较弱；后续可从 `summary_json` 迁移到 `artifact_files`。
- 现有工具事件 `changedFiles` / `file_snapshot` 可保留作辅助或后续实时层，但不是 Turn Artifact 的权威数据。

