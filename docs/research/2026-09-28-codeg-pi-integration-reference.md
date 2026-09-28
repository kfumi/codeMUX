# codeg 的 Pi 接入参考：功能地图与对 CodeMUX 的启发

- 日期：2026-09-28
- 参考项目：`D:\project\my-project\codeg`（xintaofei/codeg）
- 调研范围：codeg 中所有 agent 类型 `pi` 相关的前后端实现
- 结论性质：一手源码走查（Rust `src-tauri/src`、前端 `src`），未依赖文档站

## 结论摘要

codeg 把 pi 当作「15 个内置 agent 之一」，走 **ACP 统一总线**：它自己不做 pi 的协议实现，而是 npx 拉起社区适配器 `pi-acp@0.0.33`，由适配器再 spawn `pi --mode rpc`。代价是能力被 ACP 面削平——pi-acp 不转发 `mcpServers`、不透传 pi 的启动 flag、pi 的 `/compact` 在 codeg 内置压缩命令表里为空；收益是零成本获得统一连接、审批、会话卡片、`@` 委派与历史聚合。

CodeMUX 走的是相反路线：**直接实现 pi 原生 RPC**（`apps/sidecar/src/piRpcTransport.ts`），因此拿到了 codeg 没有的 fork/rewind、`get_session_stats` 用量、原生 compact、`--mcp-config` 真 MCP、扩展注入的审批与 ask-user。

所以这次走查真正可借用的不是协议选型，而是 codeg 在**边界诚实、历史解析纪律、安全闸门**三处的工程做法——尤其是它的 pi 项目信任门，正好落在 CodeMUX 已记录的待办上（`docs/research/2026-09-28-pi-npm-package-migration.md:45`）。

## codeg 的 Pi 功能地图

### 声明与启动

唯一权威表是 `src-tauri/src/acp/registry.rs:1552-1578` 的 `AcpAgentMeta`：

- 分发：npx 包 `pi-acp@0.0.33`（精确 pin），命令 `pi-acp`，无子命令；版本 pin 由测试钉死（`registry.rs:2350`，在 `registry_pins_current_acp_agent_versions` 内）。
- `node_required: Some("22.0.0")`：注释明说 pi-acp 自己的 engines 只写 `>=20`，codeg 取 pi 的 22+ 要求。
- 固定注入 `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`，用于让 pi-acp 广告 `promptCapabilities.embeddedContext`。
- 启动闸门：`connection.rs:1768-1794` 先跑 `pi_launch_preflight`（找不到可执行文件时报含字面量 `"is not installed"` 的错误，前端据此弹安装提示，注释禁止改词），再过项目信任闸门。
- BYO-pi：`PI_ACP_PI_COMMAND` 指向自定义 pi 构建；**pi 二进制本身不 pin**（`commands/acp.rs:12878-12882` 装 latest，注释说明其版本独立于被 pin 的适配器）。

### 配置面

前端 `src/components/settings/pi-config-panel.tsx`（约 1310 行，仅 `agent_type === "pi"` 时挂载）分三张卡：

1. **Runtime / BYO-pi**：默认（用 PATH 上的 `pi`，可一键装/卸 `@earendil-works/pi-coding-agent`）与自定义命令二选一；高级区暴露 `PI_CODING_AGENT_DIR`（配置目录）与 `PI_CODING_AGENT_SESSION_DIR`（会话目录）。明确写出**自定义 pi flag 不被 pi-acp 转发**，让用户「包一层脚本再指向命令」（`i18n:en.json:1515`）。
2. **凭据 / 模型**：直接读写 pi 原生 `~/.pi/agent/settings.json`（`defaultProvider`/`defaultModel`/`defaultThinkingLevel`）与 `auth.json`；自定义供应商写 `models.json`。思考档位声明带一段关键解释（`pi-config-panel.tsx:1025-1030`）：**未声明的模型，thinking 词汇表只有 `["off"]`，composer 发出的任何档位都会被夹回**。
3. **信任列表**：列出 pi `trust.json` 的门条目，可逐个撤销。

### 项目信任门（最值得看的设计）

`src/components/chat/pi-project-trust-banner.tsx:3-47` 的文件头把来龙去脉写全了：

- pi 会加载仓库自己的 `.pi/*`——settings、skills、prompts、themes、系统提示词覆盖，以及 `.pi/extensions`（**JS/TS 模块，其顶层代码以用户权限在 pi 启动时执行**）——但仅在该工作区被 `~/.pi/agent/trust.json` 信任后。
- pi-acp 以 `pi --mode rpc` 启动、没有 UI，pi 无法提问，默认就是跳过这些资源。
- codeg 早期版本**每次启动 pi 都替用户写这个信任**，等于静默回答「是」：仅仅打开一个克隆仓库的会话，就会执行仓库自带的 `.pi/extensions`。这个行为已删除，决策改为浮出到 banner。
- 因为 pi 只在进程启动时解析一次信任，**事后警告来不及**，所以后端在存在未确认授权时**拒绝启动 pi**（`pi_project_trust_launch_block`，`commands/acp.rs:5939-5966`），回答即放行；错误变体 `PiProjectTrustRequired`（`acp/error.rs:39-46`，wire code `pi_project_trust_required`）。
- codeg 自己的确认记录写在 codeg 家里（`<codeg_home>/pi-project-trust-ack.json`），**故意不写 pi 的 `trust.json`**；「保持信任」不碰 pi 的文件。pi 的 `trust.json` 只在用户显式操作时写，并兼容 `proper-lockfile` 锁。
- 两种状态浮出：未决（无覆盖 → 正在跳过资源，请求决策）与已授权未确认（清代的自动授权，无法与用户自己的决策区分，故不裁剪，改为披露 + 撤销入口）。
- 只对 owner 生效；delegation 子会话与 viewer 不拥有后端进程，不做决策。

### MCP：能力位撒谎 + 真闸门短路

- `registry.rs:1554-1560`：pi 的 `supports_mcp` 写 `true`，注释解释这是为了满足不变式 `only_builtin_openclaw_opts_out_of_mcp`；pi-acp 接受线缆上的 `mcpServers` 但丢弃。
- 真正的闸门在独立函数 `connection.rs:4469-4480 agent_delivers_wire_mcp`：pi 返回 `false`，注释给出后果推理——转发用户服务器或内置 codeg-mcp 都是徒劳，且注入 codeg-mcp 会让 delegation/feedback/ask **假称可用**（`feedback_tool_available` 变 true，pi 永远用不到那个 token）。
- 结果：codeg 里 pi **没有 MCP**，也不接收 codeg 的委派/反馈工具。

### 历史聚合

`src-tauri/src/parsers/pi.rs`（2507 行，33 个内联测试）是 codeg 对 pi 最深的一处投资，靠一个「单文件字节的纯函数」读 pi 自己的 JSONL。要点：

- **目录解析三级**（`pi.rs:22-142`）：`PI_CODING_AGENT_SESSION_DIR` → `<agentDir>/settings.json` 的 `sessionDir` → `<agentDir>/sessions`；`<agentDir>` 为 `PI_CODING_AGENT_DIR` 否则 `~/.pi/agent`；两个 env 都按 pi 的 `expandTildePath` 规则展开。注释交代为什么必须带 settings 层：pi-acp 也读它，缺这层会出现「pi 能恢复、codeg 历史列表永远空」。
- **相对路径坚决不解析**（`pi.rs:103-142`）：pi 的 `normalizePath` 不做绝对化，而 pi 进程 cwd 是**每个会话的工作区**，所以 `{"sessionDir":".pi/sessions"}` 是 per-workspace 目录，codeg 手上没有 cwd 便无法命名；猜（按 agentDir 解析）会指向无人写盘的目录并遮蔽默认历史。可信项目的 `<cwd>/.pi/settings.json` 会深合并覆盖全局，同样因此不解析。
- **文件是树不是日志**（`pi.rs:186-196`）：`/tree` 就地分支，按 `id`/`parentId` 链的叶子回溯即活动分支；线性读会把被放弃的分支拼进对话。`active_branch`（`511-537`）复刻 pi 的 `_buildIndex`：跳过**每一条** `type:"session"` 记录、重复 id 后者胜、访问集防环；只有存在分叉（`has_fork`，含**多个 `parentId:null` 的虚拟根**）才裁剪；无 `id` 的条目一律保留。
- **标题语义对齐 pi 源码**（`pi.rs:453-469`）：扫全部物理条目（含被放弃分支）、取**最后一个** `session_info`，且名字为空即清除。这是独立一遍 pass 的原因。
- **失败也要可读**：`stopReason:"error"` 且无内容时补 `[pi error] <errorMessage>`（`710-725`）；`bashExecution` 里 `exitCode` 缺失 = 失败（中断的命令没来得及写 exit code，默认 0 会把 Ctrl-C 画成成功，`839-868`）；`truncated` 追加提示而非丢弃。
- **历史与实时必须渲染同一串**：`tool_result_content_text` 逐字节复刻 pi-acp 的 `toolResultToText`（`1065-1089`）；`edit` 工具的 `details.patch` 若是 unified diff 就顶替那句「Successfully replaced …」回执，让重开会话后走与实时卡片相同的 `<UnifiedDiffPreview>`（`1091-1137`）。
- **压缩与分支摘要走 provider 中立壳**：`compaction` 映射成带 `_meta.contextCompaction` 的 ToolUse + 配对 ToolResult（`tokensBefore`→`preTokens`，`fromHook`→manual/automatic），复用 `<ContextCompactionCard>`；`branch_summary`/`custom_message` 落成 System turn（`display:false` 的扩展消息尊重其隐藏意图）。
- **向前兼容**：未知/畸形行一律 `continue`，永不 panic；摘要路径只读头行取 id、并走按 `AgentType` 命名空间的 `summary_cache`。
- **单点剥自己的注入**：所有 parser 由 `parsers/mod.rs:292-314` 唯一构造，外层统一包 `RouteSanitized` 剥掉 codeg 自己的 `@agent` 路由帧，避免「哪个 parser 后写就漏哪个」。

### 契约与测试纪律

- pi 的线缆契约来自**真实进程逐字捕获**：`connection.rs:20886-20889` 的注释写明下面这些帧是从 `pi-acp@0.0.33` + stub `pi --mode rpc`（经 `PI_ACP_PI_COMMAND` 覆写）逐字截取的，断言的是线缆而不是作者对 pi-acp 源码的解读。
- 没有 pi 的 snapshot/集成测试（`src-tauri/tests/parsers_snapshot.rs` 只 import 8 个 parser），pi 的契约全部由内联单测承担（registry pin / connection 帧 / question 夹具 / trust 资源识别 / skills 目录）。
- 版本 pin 的书面理由集中在 `registry.rs` 注释与 `commands/acp.rs:10860-10863`（「适配器版本 pin 在 registry.rs，升版本就是复查这些字符串的自然时机」）。
- 已知漂移：`registry.rs:1556` 注释引用的不变式名 `only_openclaw_opts_out_of_mcp` 与实际测试名 `only_builtin_openclaw_opts_out_of_mcp` 不一致。

## 与 CodeMUX 现状对照

| 维度 | codeg | CodeMUX 现状 |
|---|---|---|
| 接入协议 | ACP 总线 + `pi-acp@0.0.33` npx 适配器 | pi 原生 `--mode rpc` JSONL（`apps/sidecar/src/piRpcTransport.ts`） |
| pi 二进制 | BYO 或装 latest，不 pin | 托管 Runtime pin `@earendil-works/pi-coding-agent`（`crates/daemon/src/runtime/resolver.rs:121,148`） |
| MCP | 无（能力位为满足不变式而撒谎，真闸门短路） | 有：`apps/sidecar/src/piMcp.ts` 生成 `--mcp-config` 适配器配置 |
| 审批 / ask-user | 靠扩展 + `session/request_permission` 桥接 | 运行时生成临时扩展，`__codemux_approve__:` / `__codemux_ask__:` marker 映射（`apps/sidecar/src/piExtension.ts`） |
| 压缩 | 内置命令表对 pi 为 `None`（无 `/compact` 入口） | 原生 compact RPC，投影 `compact_boundary`（ticket 06） |
| Fork / rewind | 无（ACP 面无此能力） | `fork {entryId}` + Native mapping 重绑定（ticket 07、10） |
| 模型 / 思考 | 直写 `~/.pi/agent/{settings,auth,models}.json`，需声明 reasoning 否则档位被夹 | 托管目录 `models.json` 注入端点，`--thinking` 传档位 |
| 会话目录隔离 | 与用户 `~/.pi` 共享（读它、也写它） | `PI_CODING_AGENT_DIR` 重定向到 `<数据根>/pi-agent/`，与 `~/.pi` 硬隔离（ADR 0005） |
| 历史解析 | `parsers/pi.rs` 2507 行 / 33 测试 | `crates/daemon/src/agent/pi_history.rs` 1602 行，已实现活动链 + 目录三级解析 |
| 项目信任 | 有完整闸门（拒绝启动 + 披露 + 撤销） | 无授权入口，但**默认即不信任**且已核实（ADR 0014）：托管目录不写 `trust.json` 且 RPC 无 UI ⇒ pi 自判拒绝加载项目 `.pi/*`；设置页明示，姿态由测试钉住 |
| 默认启用 / 委派目标 | 默认启用；是 15 个 delegation 目标之一（测试钉死 enum） | 不适用：CodeMUX 没有 agent 间委派（`crates/daemon` 无 delegation 模块，`agent_runtime/*.rs` 里的 "delegates" 只是转发到 sidecar），无「委派目标名单」可对齐 |

## 可执行启发

按价值排序，逐条给出落点。

1. **pi 项目信任门（安全，最高优先）**。pi 0.75+ 默认不信任项目资源，CodeMUX 会话 cwd 就是用户工作区，所以 `.pi/extensions` 的自动执行缺口在 0.87 之后自然关闭——但这是**依赖上游默认值**的被动关闭，且托管目录里一旦存在 `trust.json` 就会翻转。建议照 codeg 的形状补一道显式闸门：默认不信任、一次性披露、明确「授权即执行仓库代码」、授权状态存 CodeMUX 自己的位置而不是 pi 的 `trust.json`（避免污染用户原生 pi）。需要先确认托管目录下 `trust.json` 的实际语义与 `--approve` 的作用面。
2. **导入路径必须剥掉 CodeMUX 自己的注入产物**。codeg 用单点 `RouteSanitized` 解决同类问题。我们有 `__codemux_approve__:` / `__codemux_ask__:` 扩展 marker 与合成工具调用，一旦用户导入原生 `~/.pi` 会话或复用被 CodeMUX 写过的会话文件，这些内部件可能出现在时间线里。落点：`crates/daemon/src/agent/pi_history.rs` 的转换出口加一层剥离，并补一条「marker 不出现在导入历史」的测试。
3. **`select_pi_active_chain` 的失败回退可以更细**。我们现在「断链/成环 → 返回全量线性」，注释的理由是「宁可交错也不丢条目」（`pi_history.rs:133-136`）。codeg 的做法不同：成环只在遍历时终止（访问集），仍按已走到的链裁剪；只有「无分叉」才完全不裁剪。差别是**成环时我们会把被放弃的分支交错进对话**，也就是 codeg 当初修的同一个 bug。建议：成环改为保留已解析链（而不是整体放弃），断链是否回退可保留现状并写清理由。
4. **模型 / 思考档位的「声明」缺口——已实测确认并修复**。codeg 指出未在 `models.json` 声明 reasoning 的模型，thinking 词汇表只有 `["off"]`，任何档位都被夹回；本机 pi 0.87.1 实测同样成立（无 `reasoning` → `levels=["off"]`、`thinkingLevel="off"`；`reasoning: true` → off/minimal/low/medium/high；再加 `thinkingLevelMap{xhigh,max}` → 7 档全开）。注意 pi 的词汇表含 `minimal`，而 CodeMUX 的 `ReasoningEffort` 只有 6 档 `none|low|medium|high|xhigh|max`（`src/types/session.ts`），故 `minimal` 不可达、无需在 UI 暴露。修复与验收证据见 `docs/plans/2026-09-28-pi-agent-integration-optimizations.md`（P0-1/P0-2）与 `docs/tickets/pi-agent-integration/12-pi-models-json-thinking-and-modality.md`。
5. **历史与实时同串的校验**。codeg 把「历史与实时不能渲染两个不同字符串」当成硬约束（`tool_result_content_text` 逐字节复刻、`edit` 的 patch 提升）。我们没有 pi-acp 这一层，但仍适用：重开会话后的时间线与当时实时流应是同一投影。落点：给 pi 的 `edit`/`bash` 结果补一条 golden 对比（实时事件序列 vs 重放导入序列），防止导入路径慢慢漂移。
6. **契约测试的来源要写清**。codeg 在测试里注明帧是真实进程逐字捕获。我们有 `apps/sidecar/src/__fixtures__/fake-pi.mjs`，方向一致；建议在 `piRpcTransport.test.ts` 里补同一句话，并标明捕获所用的 pi 版本，将来升级 pi 时知道该重捕什么。
7. **托管 Runtime 的 pin 断言测试**。codeg 用 `assert_npx_version(...)` 钉死 `pi-acp@0.0.33` 与 node 下限。我们的 `runtime/resolver.rs` 有 pi 分支但没有等价断言；建议补一条断言测试，并在包名/入口旁写清禁止回退与迁移理由（参照 `docs/research/2026-09-28-pi-npm-package-migration.md`）。
8. **摘要缓存与「只读头行」**。codeg 的 pi 摘要走按 `AgentType` 命名空间的缓存，`get_conversation` 也只读头行匹配 id。若我们的导入会在大会话目录上反复全量解析，这两条都是现成的性能模式。
9. **诚实 UI 的一条边界**。codeg 规定：当用户把 pi 指向自定义配置目录时，该 agent 从 skills 面板中排除（`src/lib/pi-config.ts:15-26`），因为 skill store 只能管默认全局目录，显示「已启用」会是假的。我们现在是托管目录（ticket 11 的同步目标就是托管目录，天然自洽）；一旦将来放开「自定义 pi 配置目录」，这就是必须同步处理的坑。

## 不采纳的部分

- **不改成 ACP 总线**。codeg 的统一总线换来了 15 个 agent 的低成本接入与自定义 ACP 注册表，但 pi 在这条路径上丢掉了 MCP、启动 flag、内置压缩入口，审批与提问要靠 `session/request_permission` 合成工具调用绕出来。CodeMUX 在 pi 上的原生 RPC 已经拿到更深的能力面，退回去是净损失。可借鉴的是它的「能力位 + 逃生口」表达方式，而非协议本身。
- **不共享 `~/.pi`**。codeg 直接读写用户的 `~/.pi/agent/{settings,auth,models}.json`，好处是与用户原生 pi 体验一致，代价是污染用户环境、且用户手改就会漂移。CodeMUX 的托管目录硬隔离（ADR 0005）应当保持；代价是用户原有的 pi 供应商/认证配置不会被会话读取，这一点需要在设置页说清。

## 未决问题

- 托管 `PI_CODING_AGENT_DIR` 下 `trust.json` 的语义 —— **已核实**：存储路径 `<agentDir>/trust.json`（pi `dist/core/trust-manager.js`），决策顺序为 `--approve`/`--no-approve` → 用户级/命令行扩展的 `project_trust` 事件 → 已保存决策 → 全局 `defaultProjectTrust`（默认 `ask`），而 `ask` 在无 UI 的 RPC 进程里直接返回 false（`dist/core/project-trust.js`）⇒ 托管目录不写 `trust.json` + RPC 无 UI 即等于默认不信任。落地为 ADR 0014（保守路线：不提供授权入口）。
- delegation 目标名单 —— **不适用**：CodeMUX 无 agent 间委派（`crates/daemon` 无 delegation 模块；`agent_runtime/*.rs` 的 "delegates" 仅指转发到 sidecar）。
- `models.json` 的 `thinkingLevelMap` 声明与档位实际生效 —— **已实测并修复**（第 4 条，见 ticket 12）。
- 大目录导入耗时 —— **已测量**：本机 `~/.pi` 只有 4 个 jsonl / 约 1.27 MB / 27 个目录，摘要缓存无可测收益，第 8 条**不做**（结论记录在计划文档 P3-3）。

## 执行落地（2026-09-28）

本文件第 1~8 条启发已由 `docs/plans/2026-09-28-pi-agent-integration-optimizations.md` 承接并执行（含偏离说明）：

- 第 1 条 → ADR 0014 + 设置页明示 + 姿态测试（保守路线，不提供授权入口）
- 第 2 条 → `pi_history.rs` 投影出口剥离 `__codemux_*__` marker（P2-3）
- 第 3 条 → 成环时保留已解析链，不再回退全量（P2-1）
- 第 4 条 → ticket 12（P0-1/P0-2：能力位 + `reasoning`/`thinkingLevelMap`/`input` 声明）
- 第 5 条 → 历史/实时孪生契约注释互指 + 两侧测试（P2-2）
- 第 6 条 → `piRpcTransport.test.ts` 与 `__fixtures__/fake-pi.mjs` 标注帧来源与版本（P3-2）
- 第 7 条 → `runtime/resolver.rs` pi 托管 Runtime 契约测试（P3-1）
- 第 8 条 → 已测量后决定不做（P3-3）
- 第 9 条 → 未触发：我们仍是托管目录，没有「自定义 pi 配置目录」入口
