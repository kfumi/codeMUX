# OpenCode 存储性能审计

研究日期：2026-09-24

## 执行摘要

本审计的主结论是：OpenCode 在 CodeMUX 中变慢，主因不是 CodeMUX 自己的映射表，而是 Rust daemon 反复打开 provider-owned `opencode.db` 的只读连接、按 message 执行 parts 的 N+1 查询，以及导入和用量统计把完整历史过度规范化。尤其是导入会再次完整发现所有 provider，OpenCode 快照 fingerprint 又取自整个数据库文件 metadata，不能用于缩小工作量。删除链路则额外受到 sidecar 生命周期影响：没有活跃 sidecar 时会启动短生命周期 sidecar，而修复前流程先 shutdown 再进行 native cleanup。

本审计只使用合成数据、只读统计和聚合耗时；没有输出、记录或在文档中展示任何真实会话标题、消息正文或工具输出。实测的最大瓶颈可以在不改变产品语义的情况下通过连接复用、parts bulk-load、专用 token SQL 和候选过滤消除；这些优化现已在当前 diff 的 OpenCode 路径实施并完成定向复测，剩余限制和后续方向见本文末尾。

## 方法与反馈环

### 审计范围

审计沿三条链路进行：

1. 静态追踪 Rust daemon 的 OpenCode 发现、导入、历史加载、用量统计、删除和回填路径，并核对 TypeScript 前端的请求编排。
2. 对生产 `discover_opencode`、`aggregate_opencode_tokens` 和最大 session 的 parts 读取做只读微基准。
3. 用合成数据库做索引敏感性实验，并用托管 OpenCode Runtime 1.18.31 测量无副作用的 start/close 生命周期成本。

临时性能测试和探针已移除，文档只保留聚合信息。真实数据库结果仅保留文件大小、行数、索引/查询计划、逻辑字节数和耗时。

临时测试命令的形态为：

```text
cargo test --manifest-path crates/daemon/Cargo.toml <temporary-ignored-test> -- --ignored --nocapture
```

### 反馈环结果（修复前基线）

以下数字是审计阶段的修复前基线，不代表当前实现性能：

- 合成数据为 500 sessions、20,000 messages、20,000 parts。生产 `discover_opencode` 在没有目标复合索引时耗时 37,018 ms；只添加 `message(session_id,time_created,id)` 和 `part(session_id,message_id,time_created,id)` 后耗时 2,570 ms，下降 93%，但仍高于 2 s 门槛。这说明索引是重要因素，却不是唯一因素；连接复用和 N+1 仍然需要处理。
- 本机真实 `opencode.db` 为 1,145,659,392 bytes（约 1.09 GB），WAL 为 23,001,992 bytes。表计数为 session 268、message 5,802、part 25,823，其中含消息的 session 为 184。freelist 为 142,077 页，即 581,947,392 bytes。逻辑 JSON bytes 为 message 19,932,703、part 75,637,464。
- 真实 message 索引为 `(session_id,time_created,id)`；part 只有 `(session_id)` 与 `(message_id,id)`。生产 parts 查询计划为 `SEARCH part USING INDEX part_session_idx (session_id=?)` 加上 `USE TEMP B-TREE FOR ORDER BY`。
- 真实最大 session 含 656 messages、2,620 parts。生产 N+1 parts 读取为 2,327.39–2,382.89 ms；单次 bulk parts 读取为 42.9–44.65 ms，约快 52–55 倍；message 查询为 6.46–6.74 ms。
- 直接运行修复前生产 `discover_opencode` 扫描真实 184 个 sessions 耗时 11,398 ms；直接运行修复前生产 `aggregate_opencode_tokens` 扫描同样范围耗时 11,518 ms。
- 托管 OpenCode Runtime 1.18.31 的无副作用 start/close 测量为：首次 start 2,503 ms、close 173 ms；热缓存三轮总耗时分别为 1,519、1,450、1,446 ms。
- 原有 `cargo test --manifest-path crates/daemon/Cargo.toml opencode_history --lib` 输出 24 passed，import fixture 1 passed；`cargo fmt --manifest-path crates/daemon/Cargo.toml --all -- --check` 通过。

## 环境数据与数据库观察

真实库的文件体积远大于逻辑 JSON 体积，且存在约 582 MB 的 freelist。这提示文件空间回收可能是运维层面的优化对象，但不能据此断言 VACUUM 会改善当前查询时延：当前主路径的耗时首先由重复连接、查询次数、排序和完整对象构造解释，且 CodeMUX 不应自动修改 provider-owned DB。

`message` 的复合索引能支持按 session 排序的 message 查询；`part` 的现有索引不能同时支持 `session_id`、`message_id` 与 `time_created,id` 的完整过滤排序，因此修复前每条 message 都会触发按 session 扫描并额外排序。这个结果与最大 session 上 52–55 倍的 N+1/bulk 对比相互印证。当前实现通过一次 bulk 查询和分组避开这条 N+1 形状，但不自动向 provider-owned DB 添加索引。

## 根因链

### 1. 发现阶段重复串行打开数据库

修复前的 `crates/daemon/src/agent/history_import.rs:780-799` 的 `discover_all` 串行处理各 provider，`:881-933` 的 `discover_opencode` 对 session 做 `DISTINCT` 后逐 session 加载 native events，发现候选已经在读完整历史。修复前的 `crates/daemon/src/agent/opencode_history.rs:1408-1417` 每次 load 都重新 find DB 并打开 read-only connection；当前实现集中在大约 `opencode_history.rs:1650+` 的 connection-aware loader，并在 `history_import.rs:890-1170` 的发现/导入路径复用连接和 metadata 聚合。

当前 `discover_opencode` 对一次扫描复用一个连接，先聚合 session metadata；旧 schema 有 fallback。无标题 session 不再逐条探索完整历史，而是使用一次 message window query，并按每批最多 400 对 message/parts 做批量 parts query。

### 2. message/parts 的 N+1 是单次加载的核心成本

修复前的 `crates/daemon/src/agent/opencode_history.rs:1618-1677` 先查每个 session 的 message，再为每条 message 调 `load_opencode_parts`；`:2087-2106` 的 parts SQL 为 `WHERE session_id=? AND message_id=? ORDER BY time_created,id`，对应真实库中缺少完整复合索引的查询计划。

当前 `load_opencode_events_from_connection` 对每个 session 一次 bulk-load parts，并按 `message_id` 分组，保留 `time_created,id` 的稳定排序和既有事件语义。由此消除了按 message 的 parts N+1，同时没有把 provider-owned DB 改写为 CodeMUX 自己的 schema。

### 3. 导入和用量把完整历史过度规范化

修复前的 `crates/daemon/src/agent/history_import.rs:116-180` 的 POST import 再次完整执行 `discover_all`，并持有 CodeMUX DB 锁逐个写入；`:1037-1092` 的 OpenCode snapshot fingerprint 来自整个 db 文件 metadata，不能帮助导入只解析选中的 candidate keys。

当前导入 POST（`history_import.rs:890-1170`）重新做轻量 discovery，只 hydrate selected keys；使用 session 级 fingerprint，并对 DB 消失或空 events 返回错误，避免把已失效的候选当作成功导入。扫描请求使用 generation，导入扫描和 usage 请求使用 150 ms debounce，阻止过时响应写回 UI。

当前 usage breakdown 在 `crates/daemon/src/services/usage.rs:542+` 整个 breakdown 复用一个 read-only connection。OpenCode token SQL 只投影 `time_created`、`role`、`tokens.input`、`tokens.output`、`cache.read`，不读取 part 或完整 message JSON。真实同范围最终生产路径复测为 103 ms；此前中间测量的 551 ms 不作为最终结果。

### 4. 删除的独立放大器是 sidecar 冷启动

修复前的 `crates/daemon/src/services/session.rs:274-300` 删除先 shutdown + reset，`:181-258` 再 best-effort native cleanup；OpenCode 分支调用 delete。修复前 `crates/daemon/src/agent/opencode_history.rs:2222-2304` 在没有活跃 sidecar 时每次启动短生命周期 sidecar，`apps/sidecar/src/opencodeSdk.ts:403-423` 每次删除都完整 start server/client/delete/close。

当前 session orchestration（`crates/daemon/src/services/session.rs:14-95`、`319+`）在普通删除流程的 native cleanup 前保留 active sidecar，官方 SDK 完成后才 shutdown；短生命周期 sidecar 则无论成功、错误或 timeout 都 cleanup。删除仍必须走 OpenCode 官方 SDK/API，以保留取消后台任务、递归子会话和附属数据清理语义。

热 server start/close 的生命周期成本仍约为 1.45–1.52 s。active sidecar 现在避免删除路径的这次冷启动；没有 active sidecar 的归档批量删除仍可能每项启动短生命周期 sidecar，但 UI 将并发限制为 3，并在部分失败时汇总结果、一次 O(N) 更新状态。共享 control sidecar 仍是后续 P1，不应声称已经实现。

## 为什么数据库操作慢

可以把修复前的成本拆成四层：

1. **连接层**：每个 load 重新 find DB、open read-only connection；跨 session/provider 串行，无法摊薄固定成本。
2. **查询层**：每个 message 查询 parts，真实库只能使用 `part_session_idx` 后对结果做临时 B-tree 排序；查询次数随 message 数线性增长。
3. **对象层**：导入、native hydration 和 usage 不仅读取 token，还把 tool、result 和完整事件反序列化/规范化。token 统计因此复用了最重的 loader。
4. **写入层**：`crates/daemon/src/db/operations.rs:697-724` 的 timeline 每事件单条 INSERT；`:831-859` 的 cleanup native session 合并后线性去重。它们会增加导入/清理成本，但不是本机 OpenCode 读取 11 秒的首要解释。CodeMUX schema 的 mapping/source 唯一约束和索引（`crates/daemon/src/db/schema.rs:67-100,497-505`）也不是 provider-owned `opencode.db` 的主瓶颈。

freelist 很大可能解释文件空间和部分维护成本，但不能替代上述查询级证据。任何维护动作都必须在完全停止 OpenCode/CodeMUX、备份 db/-wal/-shm 后由运维人员单独评估；CodeMUX 不应自动 VACUUM 或改写 provider-owned DB。

## 删除为何慢

删除的正确性边界不能通过性能优化改变：必须继续使用 OpenCode 官方 SDK/API，不能恢复直接 SQL 删除。既有研究 `docs/research/2026-08-05-opencode-session-deletion-research.md` 已记录官方删除负责取消后台任务、递归删除子会话和清理附属数据；这些语义不能由 CodeMUX 自己的表清理替代。

当前 active sidecar 会在 native cleanup 前保留到官方 SDK 完成；无 active sidecar 时仍可能为每个归档项启动短生命周期 sidecar。因此热 server start/close 约 1.45–1.52 s 的固定成本只会出现在没有可复用 sidecar 的场景。归档批量删除 UI 并发上限为 3，部分失败会汇总，不把单次失败误报为全批成功。共享 control sidecar 复用仍是后续 P1。

## 前端放大器

`src/components/layout/ImportSessionsDialog.tsx` 负责扫描与导入请求；当前扫描有 generation，导入扫描和 usage 请求有 150 ms debounce，用于阻止过时响应写回。现有 transport 不支持 `AbortSignal`，因此已经发往 server 的发现、导入或统计工作不能物理取消；这部分列为 P1，而不是声称取消已完成。

`src/components/settings/UsageStatistics.tsx:113+` 的筛选请求使用上述 generation/debounce 编排。`src/stores/agentStore.ts` 对长会话最多做 5,000 条全量解析；UI 在 120 个事件以上只裁剪渲染，不裁剪 store 加载。scheduled running session 每 3 秒 force reload，会把同一 loader 成本周期性放大。显式 session 打开和 native hydration、resync 也走同一 loader，因此它们不是完全独立于根因的“另一套慢路径”。

`src/components/settings/ArchivedSessionsPanel.tsx:25+` 使用最大并发 3 的归档批量操作，并一次 O(N) 更新状态；它不改变无 active sidecar 时每项短生命周期冷启动的可能性。

## 操作风险矩阵

下表先列修复前问题，再列当前路径已消除或保留的成本；非 OpenCode provider 仍按既有逻辑完整发现，本轮优化只针对 OpenCode。

| 操作 | 修复前实现 | 当前实现/剩余成本 | 本次主因 |
|---|---|---|---|
| 候选扫描 | `discover_all` 串行 provider；OpenCode 先 DISTINCT session，再逐 session 加载 native events | OpenCode 单连接 metadata aggregation、旧 schema fallback、无标题 session message window + 批量 parts；非 OpenCode provider 保持既有完整发现 | 已优化 |
| 真正导入 | POST import 再次完整 `discover_all`，持 CodeMUX DB 锁逐个写入；固定 refresh existing | 轻量 discovery，仅 hydrate selected keys；session fingerprint、DB 消失/空 events 错误；generation/debounce | 已优化 |
| 会话打开 / native hydration | 打开或恢复时走同一 OpenCode full loader | connection-aware bulk parts loader；仍有 store 上限和完整事件构造成本 | 部分优化 |
| resync / 定时 reload | 显式 resync 和 scheduled running session 每 3 秒 force reload | generation 只能阻止旧响应写回，现有 transport 不能取消已发 server 工作 | 后续 P1 |
| usage breakdown | `services/usage.rs` 逐个 session 聚合并复用最重 loader | 整个 breakdown 复用一个 read-only connection；只投影 time/role/input/output/cache.read | 已优化 |
| composer / latest token usage | `opencode_history.rs:1993-2006` 倒序读取 message | 仍有重复 open/解析固定成本，但不是 11 s 主因 | 次要 |
| 删除 | 先 shutdown/reset，再 native cleanup；无活跃 sidecar 时启动短 sidecar | active sidecar 保留至官方 SDK 完成；无 active 归档批量可能每项冷启动，UI 并发 3；共享 control sidecar 后续 P1 | 部分优化 |
| Fork | 主要调用 OpenCode 官方 SDK/server 创建分支并处理生命周期 | server 往返、runtime 与生命周期；边界校验仍有 parts 查询 | 非本轮重点 |
| rewind | 主要通过官方 SDK/server 和会话生命周期完成回退 | server/任务取消与恢复；边界校验会触发 parts 查询 | 非本轮重点 |
| subagent backfill | OpenCode 子代理回填再次打开 DB，遍历 child sessions/parts | child session 数 × message/parts 仍可能放大 | 局部后续项 |
| MCP / Skills | 小型 JSON/目录扫描与缓存 | I/O 与缓存失效，通常不随 OpenCode message 数增长 | 否 |
| Provider 模型 | 通过 15 s 网络请求获取模型 | 网络等待与 provider 响应 | 否 |
| Runtime 安装 / 升级 / 诊断 | npm、进程启动/停止、版本与健康检查 | 包管理、进程和 I/O 成本 | 否 |

## 非主因与需要避免的误判

- CodeMUX 的 mapping/source schema 约束和索引不是读取 provider-owned `opencode.db` 的主瓶颈。
- 单次 message 查询在最大 session 中只有 6.46–6.74 ms；不能把全部 2.3 s 归因于 message 表。
- composer/latest token usage 已有 message 复合索引且通常只读少量倒序行；它的重复连接/解析值得优化，但不能解释真实库的 11 s 全量统计。
- MCP、Skills、Provider 模型和 Runtime 操作分别是小型目录/JSON、网络、npm/进程成本，不是当前会话数据库慢的主因。
- freelist 和 1.09 GB 文件体积提示维护机会，但不是自动 VACUUM 或 CodeMUX 改写 OpenCode 数据库的理由。
- 当前 543 ms/103 ms 是生产路径同范围复测；551 ms 是较早的中间测量，应以最终 103 ms 为准。

## 修复实施与复测

当前 diff 已实施以下 OpenCode 专项修复：

- `load_opencode_events_from_connection` 对每个 session 一次 bulk-load parts，并按 `message_id` 分组。
- `discover_opencode` 使用单连接 metadata aggregation，提供旧 schema fallback；所有无标题 session 使用一次 message window query，再按每批最多 400 对 message/parts 批量查询 parts。
- 导入 POST 重新执行轻量 discovery，只 hydrate selected keys；使用 session 级 fingerprint，并对 DB 消失或空 events 返回错误。
- usage 整个 breakdown 复用一个 read-only connection，SQL 只投影 `time_created`、`role`、`tokens.input`、`tokens.output`、`cache.read`，不读取 part 或完整 message JSON。
- 普通删除流程在 native cleanup 前保留 active sidecar，官方 SDK 完成后再 shutdown；短生命周期 sidecar 在成功、错误和 timeout 时都 cleanup。
- 归档批量删除最大并发 3，部分失败汇总，并以一次 O(N) 操作更新状态。
- 导入扫描和 usage 使用 generation 与 150 ms debounce，防止旧响应写回。

真实本机同范围修复前后复测（临时探针已移除）：

| 路径 | 修复前 | 当前最终生产路径 | 变化 |
|---|---:|---:|---:|
| metadata discovery（184 sessions） | 11,398 ms | 543 ms | 约 21× |
| OpenCode usage projection（同一范围） | 11,518 ms | 103 ms | 约 112× |

543 ms 和 103 ms 均以最终生产路径为准；先前 551 ms 的中间测量不替代最终 103 ms usage 结果。热 server start/close 仍约 1.45–1.52 s；active sidecar 避免普通删除的冷启动。没有 active sidecar 的归档批量删除仍可能每项短生命周期冷启动，但 UI 并发为 3；共享 control sidecar 留作 P1。

现有前端 transport 不支持 `AbortSignal`。generation/debounce 只阻止旧响应写回，不能物理取消已经发出的 server 工作，列为 P1。全部来源导入中的非 OpenCode providers 仍按既有逻辑完整发现；本轮只优化 OpenCode。

## 分阶段修复方向与当前状态

### P0：减少读取和删除的固定/重复成本（已实施）

1. 在一次扫描中复用一个 read-only `Connection`，让 OpenCode provider/session 扫描共享连接和查询准备。
2. 每个 session bulk-load parts 并按 `message_id` 分组；保留 `time_created,id` 的稳定排序和现有事件语义。
3. 为 OpenCode token 统计提供专用 SQL，只读取 message 的 role、tokens、time 等必要字段，不构造 tool/result/完整事件。
4. 发现阶段只读 session metadata，在 daemon 端按 cwd 过滤；导入阶段只解析 candidate keys，并以 key/freshness 校验防止 TOCTOU。
5. 删除优先复用 active sidecar；批量删除限并发，并保留官方 SDK 的递归子会话和附属数据清理语义。

### P1：降低编排、写放大和长会话成本（部分未实施）

- 前端需要可真正取消底层工作的 transport/服务端取消机制；当前 generation/debounce 只能阻止过时响应写回。
- 归档批量删除可进一步复用共享 control sidecar，避免无 active sidecar 时每项冷启动。
- 在 daemon 端增加服务端缓存/增量更新，优先按时间或事件游标追加，而不是每次重新规范化完整历史。
- timeline 使用批量 prepared insert；native cleanup 的去重可在有明确收益时改为更合适的集合/索引策略，但不要以牺牲正确性为代价。
- 长会话改为分页、尾部增量或按需 hydration；store 不应每次都重新解析最多 5,000 条，UI 裁剪不能替代数据层裁剪。
- 非 OpenCode provider 的完整发现策略本轮未改变，后续如需统一优化应另行评估，不能把本轮 OpenCode 结果外推到所有来源。

### P1/P2：性能回归与可观测性

- 加入大规模性能 fixture 和门槛，覆盖 discover、import、usage、open/delete 编排，而不是只测单条 SQL。
- 记录按 session/message/parts 数量分桶的耗时、查询次数、连接建立次数、bulk 命中率和 sidecar start/close 生命周期；只记录聚合指标，不记录真实会话内容。
- 建议 SLO（均为目标，不是当前承诺结果）：184 sessions 的 metadata discover p95 <500 ms；选中候选的 import <1 s；usage cached <300 ms、cold <1 s；warm delete <500 ms。SLO 应在代表性硬件、固定数据规模和明确缓存状态下重新校准。

## 风险与正确性约束

1. **provider-owned DB 边界**：CodeMUX 可以只读审计和通过官方 API 操作，但不应自动修改 OpenCode schema、写 provider-owned DB 或执行 VACUUM。
2. **删除语义**：必须继续走 OpenCode 官方 SDK/API。直接 SQL 删除无法保证官方入口负责的后台任务取消、子会话递归和附属数据清理。
3. **TOCTOU 与 freshness**：从候选发现到导入必须校验 session key、映射和快照 freshness；metadata 快照不能替代正式读取时的存在性校验。
4. **索引实验不等于生产变更**：合成 fixture 中添加索引后的 2,570 ms 仅证明查询形状的敏感性，不代表可以直接在用户数据库上创建索引或满足 SLO。
5. **缓存与取消语义**：缓存必须区分 provider DB 变化、CodeMUX 映射变化和 generation；取消前端请求不能把已经提交的服务端写入误报为成功。
6. **维护动作**：若要评估 VACUUM，先完全停止 OpenCode/CodeMUX，备份 `opencode.db`、`-wal`、`-shm`，再由运维人员离线执行和验证；不能把它纳入正常删除或导入路径。

## 测试结果

审计阶段基线曾确认：`opencode_history --lib` 24 passed，import fixture 1 passed，`cargo fmt --all -- --check` 通过；这些是修复前记录，不代表当前实现的完整验证。

最终验证全部通过：根前端 `npm run build` 通过，Vitest 239 个文件、1,963 个测试通过；sidecar `npm run build` 通过，Vitest 60 个文件、676 个测试通过；Rust fmt、clippy（无 warning）和全目标/全 feature 测试通过，其中 562 个测试成功、0 个失败；`npm run build:daemon` 通过。临时性能探针与调试标记均已移除。
