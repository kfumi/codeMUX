# codeMUX Domain Context

## Glossary

### Turn
一次用户发送消息到 Agent 给出完整回复结束的交互单元（一个 user message → 对应 assistant 完成）。  
产物总结默认按 **Turn** 挂载，而不是整个 Session 的累计改动。

### Workspace Baseline
在用户点击发送、Agent 开始执行之前，对项目工作区拍下的基线快照。  
语义是「当时磁盘上的完整工作区状态」（含已有未提交改动），**不是** `git HEAD`。

### Git Tree Baseline
Workspace Baseline 的 Git 实现：用临时 index 对工作区 `add -A` 后 `write-tree` 得到的 tree object hash。  
用于在 Turn 结束后与当前工作区做对比。

### Turn Artifact
某次 Turn 结束后，相对其 Workspace Baseline 计算出的「本轮最终文件改动结果」。  
包含：改动文件列表、每文件 +/- 行数、可展开查看的 Diff、撤销能力。  
它表示 **AI Task 的最终影响**，不是 Git 仓库相对 HEAD 的状态，也不是中间每一次 tool call 的过程历史。

### Artifact Summary Card
挂在对应 assistant 回复下方的 UI 卡片：折叠态展示「N 个文件已更改 +X -Y」，展开后列出文件并可审查 Diff / 撤销。

### Turn Completion (for Artifact)
仅当 Turn **正常完成**时生成 Artifact Summary Card。用户 interrupt、Agent error 等非正常终止：不生成、不展示产物卡。

### Turn ID
每次 `startQuery` 生成的客户端 UUID，仅用于**运行中**关联 baseline、生成状态与 UI 挂载。不单独作为跨重载的权威业务键（可冗余存储）。

### Turn Ordinal
该会话在 **agent history** 中 user 消息的 1-based 序号。  
仅在 **正常完成并持久化 Turn Artifact 时**赋值；取消/失败不占号。  
**禁止**用 UI 乐观 user 列表条数作为持久化序。  
历史重载时：history 重建出的第 N 个 user ↔ `(app_session_id, N)` 的 artifact。

### Rewind vs Artifacts
会话回退裁掉尾部 turns 时，必须删除（或作废）对应 `turn_ordinal >= 回退点` 的 Turn Artifacts，保证不遗留、不重复展示。

### Artifact File Snapshot
Turn Artifact 中单个文件的 before/after 文本快照（`original` / `current`），在 Turn 正常完成时固化写入 SQLite。用于历史 Diff 展示与按快照撤销，而不是事后再对当前磁盘做 diff。

### Safe File Revert (U2)
Artifact 的撤销是**整轮撤销**，不提供单文件撤销：仅当每个文件当前内容仍等 artifact.current 时恢复 artifact.original（新增文件则删除）；当前已等 original 的文件视为已恢复；其它内容视为冲突。整轮成功后整张卡标记 `reverted`，原始 Diff 仍可查看。

### Empty Turn Artifact
本轮相对 Workspace Baseline 无文件变化时：不展示 Artifact Summary Card（E1）。

### Baseline Capture Failure
Git Tree Baseline 采集失败或超时：本轮不生成产物卡，Agent 仍正常执行（F1）。

### Artifact Diff Navigation
Artifact Summary Card 内只展示文件列表元数据；查看具体 Diff 时导航到 Preview Diff 面板，使用 Artifact File Snapshot 的 before/after，而非实时 git status。

### Artifact Pipeline (L1)
Turn Artifact 的 baseline 采集、对比生成、SQLite 读写以 Rust 为主；前端负责 turn 生命周期编排与 Artifact Summary Card 渲染。

### History-Authoritative Turn Ordinal (O3)
正常完成时由 Rust 轻量读取对应 Agent history，仅统计 user 消息，生成当前 1-based `turn_ordinal`。零文件成功 turn 不生成卡，但仍占历史序号。

### Artifact Persistence (DB2)
第一期每个 Turn Artifact 使用 SQLite 单表一条记录；摘要、文件列表、before/after 快照、文件撤销状态放在 `summary_json`。暂不拆文件子表。

### Reverted Artifact (V2)
整轮 Safe File Revert 成功后整张卡标记 `reverted`；原始文件列表、改动总计和原始 Artifact Diff 仍可查看，历史事实不被删除。

### Artifact History Loading (H3)
Rewind 成功立即删除被裁掉尾部的 artifacts；历史加载再次按 Agent history user 数过滤，并只挂到实际存在的正常完成 assistant turn。Agent history 是会话存在性的权威来源。

### Artifact Load Timing (A1)
`loadSessionMessages` 读取历史时同时加载该 session 的 Turn Artifacts；Rust 端先做 H3 过滤，前端一次性写入 store 并按 turn 序渲染。

### Effective User Turn (C2)
`turn_ordinal` 只统计 Agent history 中真实用户输入；排除 tool result、compact、Task notification、transcript-only 等内部 user 事件。Rust 与前端隐藏 user 事件的判定必须一致。

### Turn Boundary Authority (C2-B)
Rust 在 history 解析/输出时提供标准化 turn 元数据（`turn_ordinal`、`is_effective_user_turn`）；前端不按事件数组位置自行推断序号，完成事件和历史消息都按该 metadata 绑定 Artifact。

### Artifact Completion API (R1)
新增独立 Rust `build_turn_artifact` command；成功完成钩子传入 session/project/turn/baseline，Rust 计算序号、生成快照、事务持久化并返回 Artifact/null，按 session + ordinal 幂等。

### Baseline Capture API (BAPI-1)
发送前独立调用 Rust `capture_workspace_baseline(projectPath)`；前端保存 `turnId + baselineTree`，完成时显式传入。Rust 用唯一临时 index，不改用户 index/worktree；失败不阻断 Agent。

### Concurrent Workspace Changes (X1)
Artifact 表示 baseline 到正常完成期间工作区的最终变化；期间用户或其他进程的改动可以混入，不做来源归因、不锁定工作区。

### Large/Binary Artifact Files (SIZ1)
单文件按 UTF-8 字节数限制为 `1 MiB`。二进制或超限文本只保留元数据，卡片列出但 Preview 内联 Diff 与 Safe File Revert 禁用并说明原因。

### Safe File Revert API (RV1)
撤销使用 `artifactId` 调用 Rust；Rust 从 Artifact 解析项目根与全部文件快照，校验路径并执行整轮 compare-and-write 与 `reverted` 状态更新。前端不传绝对路径或快照内容。

### Idempotent Safe Revert (RF2)
Rust 对整轮 Artifact 文件操作加短锁并原子替换，先预检查全部文件：每个文件必须有完整快照，且当前等 `artifact.current` 或已等 original；任一冲突、无快照、路径异常都整轮不写入、不标记 reverted，并返回具体失败文件。全部通过后再恢复并标记。

### Artifact Store Index (ST1)
前端以 `artifactsBySession[appSessionId][turnOrdinal]` 为唯一视图索引；运行态 `turnId` 只关联 baseline/完成请求，历史、Rewind、撤销都按 session + ordinal 更新。

### History Event Metadata (META1)
Rust 给有效 turn 的历史事件统一补 `turn_ordinal`；真实 user 标记 `is_effective_user_turn=true`，内部 user 不标记。历史 assistant/result 直接按该字段关联 Artifact；实时事件完成后由前端建立 turnId → ordinal。

### Artifact Generation UI (UI2)
助手回复正常成功即结束，完成流程内 await Artifact 生成；有改动后直接挂到 final assistant。空改动、baseline/生成失败不留卡片，不显示占位。

### Artifact File Row (ROW1)
文件行只显示路径/status、+/-、打开 Preview Diff；撤销只提供卡片级整轮操作；reverted/无快照时按整轮规则处理，冲突显示 Rust 错误。

### Artifact Card Default (CARD1)
Artifact 卡默认折叠；折叠显示本轮原始文件数与 +/- 及整轮已撤销状态；展开状态只在当前 UI 生命周期保留。

### Artifact Diff Preview (DIFF1)
Preview 支持 Artifact 来源和完整 before/after 快照；Artifact Diff 直接使用持久化内容，不读实时磁盘。无快照文件禁用打开。

### Reverted Card Display (AFTER1)
整轮撤销成功后保留完整卡片、文件列表和原始 Diff；顶部显示已撤销，撤销按钮禁用；状态持久化，历史重开仍显示。

### Revert Card Action (UNDO1)
卡片头部右侧提供整轮撤销，折叠/展开均可见；确认后显示处理中，成功显示已撤销并禁用，失败显示冲突文件/原因且不改状态。

### Project Path Binding (PATH1)
每轮固化 `startQuery` 的 `cwd`；Artifact 生成、Preview Diff、整轮撤销使用 `turn_artifacts.project_path`，不读取完成时的 active project。

### Synchronous Post-Completion (SYNC2)
正常 result 先结束助手回复，再在完成流程中 await Artifact 生成；有改动后插入卡片，空改动/失败不显示，后处理失败不回滚 Agent 完成状态。

### Artifact Failure Policy (FAIL1)
Artifact 后处理失败静默降级：不展示、不重试、不阻断后续对话，只记录带 session/turn/project 上下文的日志；Git Review 作为兜底。

### Artifact Database Migration (MIG1)
现有数据库初始化时自动 `CREATE TABLE IF NOT EXISTS turn_artifacts` 和索引；不引入独立 schema version，老用户升级后直接拥有空表。

### Artifact Cleanup (GC1)
`turn_artifacts.app_session_id` 外键 `ON DELETE CASCADE`；删除会话或项目时随现有级联删除，不保留孤儿 Artifact/外部快照文件。

### Rewind Cutoff (RW1)
Rust rewind 成功后返回标准化 `cutoffOrdinal`；前端用它调用 Artifact GC，删除 `ordinal >= cutoffOrdinal`。前端不从 UI events 推算回退边界。

### Rewind GC Failure (RGC1)
history 已回退但 Artifact GC 失败时返回错误；前端清内存 Artifact 并按 H3 重载过滤。下次打开/再次 rewind 可重试，不静默当作完整成功。

### Turn Revert Result (RET1)
整轮撤销返回结构化结果：成功 `{ status: 'reverted', artifact }`；预检查冲突 `{ status: 'conflict', conflicts: [{ path, reason }] }` 且零文件写入；invoke 异常按普通错误处理。

### Snapshot Encoding (ENC1)
`summary_json` 直接保存 UTF-8 JSON strings；Rust serde 负责转义和读写，不做 Base64/压缩。二进制/超限文件只存元数据。

### Artifact JSON Version (VER1)
`summary_json` 顶层固定 `schemaVersion: 1`；缺少可选字段使用默认值，未知版本跳过并记日志，不阻塞历史加载；独立于数据库 schema version。

### Artifact ID (ID1)
Rust 生成 UUID 作为 `artifactId` 主键；客户端 `turnId` 仅追踪/日志，可选持久化；历史和业务唯一性使用 session + ordinal。

### Invalid Project Path (PATHFAIL1)
路径失效时仍展示 Artifact 和持久化 Diff；整轮撤销禁用并说明原因，不隐藏、不自动猜测或重绑定路径。

### Path Recovery Probe (PATHREC1)
加载/刷新时重新探测路径可用性；恢复后启用撤销，但点击时 Rust 仍需再次校验和全量预检查。

### History Normalization (NORM1)
Rust 直接在三个历史加载接口补齐 turn metadata；实时 sidecar 不改，完成时 Artifact command 返回 ordinal。有效 user 规则集中在 Rust。

### Message UUID
Agent 原生消息 UUID，用于标识一轮具体对话消息。前端 assistant message 的 `uuid` 作为跨层日志中的 message ID。

### Log Context
跨层日志上下文，包含应用 session ID 和可选的 message UUID。Rust 核心路径使用 task-local 上下文，Sidecar 使用轻量运行时上下文；日志以 `[session=...][msg=...]` 前缀输出。

## Preferred Terms


| Use | Avoid |
|-----|-------|
| Turn Artifact | session diff, git status, tool-call history |
| Workspace Baseline / Git Tree Baseline | HEAD snapshot（除非明确讨论相对 HEAD） |
| Artifact Summary Card | changedFiles bar（旧内存态称呼） |
| Artifact File Snapshot | live git status content |
| Safe File Revert | git restore / HEAD revert（除非明确 Git Review） |

## Out of Scope (for this feature's first cut)

- Agent 中间修改过程 / 每次 tool call 的文件变化历史
- 非 Git 项目的产物总结（第一期降级为不展示）
- 实时（streaming 中）产物预览（可选后续增强）
- 零文件改动的产物卡（E1：不展示）
- 单文件撤销（第一期仅整轮 Safe File Revert）
- Baseline 失败时阻断发送或降级工具事件 changedFiles
- 卡片内嵌完整 Diff / 独立 Modal Diff 查看器（第一期走 Preview Diff）
