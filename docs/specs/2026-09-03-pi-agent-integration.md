# pi 接入为第四智能体

**Status:** ready-for-agent

## Problem Statement

CodeMUX 目前提供 Claude Code / Codex / OpenCode 三种可用的编码智能体（`gemini_cli` 仅为占位）。pi（npm 包 `@mariozechner/pi-coding-agent`，下称 pi）是一个极简、多供应商、可扩展的终端编码智能体，拥有自己的 RPC 嵌入协议。用户希望在 CodeMUX 中直接选择 pi 驱动会话——流式对话、工具调用、上下文压缩、用量统计、会话恢复与 Fork 等体验与其余智能体一致——而不必离开应用另开终端，也不必放弃 CodeMUX 统一的 Model Provider 配置与会话时间线。

## Solution

新增 `pi` Agent Kind，作为第四个可用智能体接入现有三层架构（前端注册表 → Rust runtime 契约 → sidecar 事件桥接），不改动存量三种智能体的任何行为。

- **进程模型**：托管 Runtime 安装锁定版本的 pi CLI；每个 pi 会话由 sidecar spawn 一个长期存活的 `pi --mode rpc` 子进程，`delete/shutdown` 时 dispose（与 Codex app-server 的进程模型同构，见 ADR 0010 先例）。
- **协议桥接**：sidecar 内新建 JSONL RPC 传输层（请求/响应按 id 关联、控制面 30s 超时、compact 不限时），将 pi 事件流（流式 delta、工具执行、压缩、turn 生命周期）翻译为 CodeMUX Event（ADR 0003）。
- **供应商（ADR 0005）**：沿用 CodeMUX 自有 Model Provider，凭据与端点经 `PI_CODING_AGENT_DIR` 托管目录下的 `models.json` 注入（pi 不读取端点类环境变量）、`--model codemux/<modelId>` 选型；配置目录重定向同时不读写 `~/.pi` 原生配置，空 Key 不隐式回落 pi 自身登录。
- **能力边界**：pi 无原生审批与文件快照，相应能力声明为不支持，UI 隐藏权限选择；token/cost 用量经轮询 `get_session_stats` 支持；`/compact` 映射 pi 原生 compact RPC。
- **会话连续性**：新会话经 `PI_CODING_AGENT_DIR` 重定向落入 CodeMUX 管理目录（`<piConfigDir>/sessions/`），`get_state` 回读会话文件路径作为 Native Session mapping；重启后以 `--session <file>` 恢复。会话创建时绑定 kind（会话内 Agent Kind Switch 已随 Session Timeline 重构撤销），Fork 为同种类原生拷贝。

存量 `~/.pi` 会话导入、审批流、会话树 rewind 等列为二期，见 Out of Scope。

## User Stories

### 安装与就绪

1. As a 用户，我希望新建会话时能在智能体选择器中看到 pi，以便像其他智能体一样选择它开始对话。
2. As a 用户，我希望 CodeMUX 托管 Runtime 自动安装正确版本的 pi CLI，以便无需自己配置 PATH 或全局 npm 包。
3. As a 系统维护者，我希望 Runtime 完整性检查包含 `pi` 可执行文件，以便缺失或损坏时尽早暴露而非对话时 silent fail。
4. As a 用户，我希望升级 CodeMUX 后托管 Runtime 将 pi 更新到新的锁定版本，以便持续获得协议兼容性修复。
5. As a 用户，当 pi Runtime 未安装或损坏时，我希望新建/发送入口给出可读的安装指引，而不是模糊的运行错误。
6. As a 用户，我希望设置页的安装文档与托管 Runtime 实际安装的 npm 包名、命令一致，以便手动排障时不被误导。

### 基础对话

7. As a pi 用户，我希望发送消息后看到流式文本回复，以便及时了解 agent 进展。
8. As a pi 用户，我希望看到思考过程（reasoning）流式展示并可折叠，以便理解 agent 的推理路径。
9. As a pi 用户，我希望中断正在运行的 turn，以便在 agent 跑偏时及时停止。
10. As a pi 用户，我希望在 turn 进行中发送的消息按 CodeMUX 现有排队行为送达 pi（steer/follow-up），以便不丢失想补充的上下文。
11. As a pi 用户，我希望随消息附带图片并在模型支持视觉时生效，以便讨论截图与设计稿。
12. As a 使用非视觉模型的用户，我希望图片附件按 ADR 0006 走富化通道，以便 pi 会话与其他智能体的附件体验一致。
13. As a pi 用户，我希望 turn 超时与空闲守卫遵循 ADR 0004 的统一策略，以便 pi 会话不会永久挂起也不会被误杀。
14. As a pi 用户，当 pi 子进程崩溃时，我希望看到可读错误并能在重试后继续会话，以便不必重启整个应用。
15. As a pi 用户，我希望关闭会话或退出应用时 pi 子进程被正确清理，以便不泄漏后台进程。

### 模型与供应商

16. As a pi 用户，我希望模型目录来自 pi 的 `get_available_models` 并与 CodeMUX Model Provider 的协议端点匹配，以便只看到当前供应商可用的模型。
17. As a pi 用户，我希望在会话内切换模型并即时生效（`set_model`），以便中途换用更强或更便宜的模型。
18. As a 用户，我希望 pi 的供应商凭据由 CodeMUX 经托管目录 models.json 注入，以便遵循统一的 Model Provider 配置而不碰 `~/.pi`。
19. As a 用户，当供应商未配置或 API Key 为空时，我希望 pi 会话发送前被拦截提示，而不是隐式回落 pi 自身认证（ADR 0005 第 4 条）。
20. As a 使用第三方供应商的用户，当其协议端点无法映射为 pi 可用的供应商 api 类型（anthropic-messages / openai-completions）时，我希望该供应商对 pi 不可用并在发送前拦截，以便得到明确反馈而非静默失败。
21. As a pi 用户，我希望为会话选择思考等级（off/minimal/low/medium/high/xhigh/max，默认 medium），以便在速度与推理深度间权衡。

### 上下文管理

22. As a pi 用户，我希望执行 `/compact`（可带自定义指令）触发 pi 原生压缩，以便长会话继续工作。
23. As a pi 用户，我希望压缩过程与完成以时间线条目呈现，以便了解上下文何时被整理。
24. As a pi 用户，我希望自动压缩遵循 pi 自身默认行为，以便不需要额外配置即可长跑。

### 用量与统计

25. As a pi 用户，我希望 token 用量与成本进入 CodeMUX 用量统计，以便统一掌握各智能体开销。
26. As a pi 用户，我希望看到当前上下文占用（tokens / context window 百分比），以便判断何时需要压缩。

### 会话生命周期

27. As a pi 用户，我希望重启应用后能继续之前的 pi 会话（`--session` 恢复原生上下文），以便不丢失工作状态。
28. As a pi 用户，当原生会话恢复失败时，我希望收到明确 System Event 且对话气泡仍完整，以便理解 CodeMUX 时间线仍是权威。
29. As a pi 用户，我希望 Fork 当前会话生成同种类的独立副本（原生会话文件拷贝），以便在不影响原会话的情况下尝试分支方案。
30. As a pi 用户，我希望删除会话时对应的 pi 会话文件一并清理，以便不留垃圾文件。
31. As a pi 用户，我希望重开会话时看到完整的 CodeMUX 时间线历史，以便 CodeMUX Event 快照始终是权威记录。
32. As a pi 用户，我希望会话标题与首条消息预览正常生成，以便在会话列表中识别会话。

### 权限与安全

33. As a pi 用户，我希望权限模式选择器对 pi 会话隐藏，并明确提示「pi 直接执行工具、无审批弹窗」，以便理解该智能体的信任模型。
34. As a 系统维护者，我希望 pi 接入不读写用户 `~/.pi` 目录下的任何原生配置，以便不与用户手动安装的 pi 互相踩踏（ADR 0005 第 4 条）。

### 移动端与诊断

35. As a Mobile Companion 用户，我希望已有 pi 会话的时间线在手机端正常查看与继续，以便离开桌面时不错过进展。
36. As a 系统维护者，我希望 pi 的关键生命周期与协议错误进入结构化日志（ADR 0002），以便可按现有日志排查路径定位问题。
37. As a 用户，当 pi 返回协议错误（如模型不存在、RPC 失败）时，我希望看到原样透传的可读错误信息，以便自行修正配置。

## Implementation Decisions

- **注册面**：`AgentKind` 新增 `'pi'`；智能体注册表新增条目（label「pi」，capabilities：`supports_resume`、`supports_tools`、`supports_cost`；不含 `supports_ask_user_question` 与 `supports_file_snapshots`）；新增品牌图标；模型供应商校验分支按 pi 的端点映射规则实现。`gemini_cli` 占位保持不变。
- **进程模型**：每个 pi Native Session 一个长期存活的 `pi --mode rpc` 子进程；`ensure_session` 时 spawn，`delete/shutdown` 时优雅关闭（2s 宽限→强杀）。
- **JSONL RPC 传输层（sidecar 新模块）**：
  - 严格按 `\n` 切帧并剥离尾部 `\r`；不得使用 Node `readline`（其会在 U+2028/U+2029 处错误切分，pi 文档明确警告）。
  - 请求/响应按可选 `id` 关联；控制面调用统一 30s 超时；`compact` 属长阻塞 LLM 任务，不设墙钟超时（仅随进程退出或会话关闭而失败）。
  - stderr 维护有界环形缓冲用于诊断；进程异常退出时 reject 所有未完成请求并广播 `process_exit`。
- **事件映射（sidecar 纯函数模块）**：`message_update` 的 text/thinking delta 映射为流式事件；`tool_execution_start/_update/_end` 按 `toolCallId` 关联映射为 CodeMUX 工具事件；`turn_start/_end`、`agent_start/_end`、`agent_settled` 映射 turn 生命周期与 Turn Outcome；`compaction_start/_end` 映射压缩时间线条目（trigger 按 manual/auto 归类）。COMPAT：pi ≤ 0.83 的 `message_update` 携带累积全文而非 delta，需去重截断。
- **会话映射与恢复**：新会话经 `PI_CODING_AGENT_DIR` 重定向落入 CodeMUX 管理目录（会话文件位于 `<piConfigDir>/sessions/`），启动后经 `get_state` 回读 `sessionFile` 并存为 Native Session mapping；恢复以 `--session <file>` 启动并还原该会话的模型与思考等级；恢复失败时 mint 新会话并 emit System Event（沿用现有 native_session_rebuilt 语义）。
- **供应商注入（ADR 0005）**：会话选定的 Model Provider 经协议端点映射后注入——pi 不读取 `*_API_KEY`/`*_BASE_URL` 环境变量；端点经 `PI_CODING_AGENT_DIR` 下 `models.json` 注入（anthropic 端点 → api `anthropic-messages`，openai_compatible 端点 → api `openai-completions`，apiKey 内联于供应商条目）；`--model codemux/<modelId>` 使用固定 `codemux` 供应商命名空间。无法映射的供应商对 pi 不可用，发送前拦截；空 Key 不回落 `~/.pi` 自身认证。
- **思考等级**：静态七档映射 `set_thinking_level`，默认 medium；随会话的 Kind Model Selection 一起记忆。
- **用量**：turn 边界触发的 3s 间隔轮询 `get_session_stats`，映射 input/cacheRead/output tokens、cost 与 contextUsage；旧版 pi 缺该命令时回退 `get_state.contextUsage`。
- **排队消息**：turn 进行中的入队消息映射 pi 的 steer/follow-up 语义（默认 one-at-a-time）。
- **Fork / Delete**：Fork = 拷贝 pi 会话文件为新 Native Session mapping + 新 CodeMUX 会话；Delete = 清理 CodeMUX 会话与对应 pi 会话文件。
- **托管 Runtime**：安装目标为锁定版本的 `@mariozechner/pi-coding-agent`，完整性检查包含 `pi` 可执行文件；设置页安装指引同步更新（对齐 Codex CLI 托管化改造的既有做法）。
- **Rust 面**：`agent_runtime` 新增 pi 薄壳 runtime 实现既有 trait，工厂与 kind 枚举各加一分支；会话删除/Fork 等命令按 kind 扩展；`sessions.agent_kind` 为无约束 TEXT，无需 DB 迁移。
- **移动端**：不新增 pi 专属 UI；pi 会话经通用时间线与 Companion 通道自然可见，仅回归验证不破坏。
- **日志**：pi 子进程 stdout/stderr 的关键事件与协议错误按 ADR 0002 结构化日志上下文落盘。

## Testing Decisions

- **唯一新增 seam：sidecar pi 传输层的进程端口。** spawn 以可注入端口暴露，测试用确定性的 fake-pi 子进程（讲同一 JSONL RPC 协议的桩脚本）替代真实 pi CLI。真实的 runtime 类与事件映射跑在 fake 上，只断言外部可观察行为：启动 argv、帧解析边界（含 `\r`、多行 JSON、超长行）、请求/响应关联、事件→CodeMUX Event 序列、usage 轮询节奏、控制面超时、进程退出传播与关闭清理。先例：Codex app-server 传输层与 fake-app-server 测试基建（同一形态，已被验证好用）。
- **事件映射为纯函数单测**：给定 pi 事件序列断言 CodeMUX Event 序列，覆盖 delta 去重 COMPAT、乱序 toolCallId、压缩 trigger 归类。先例：OpenCode 事件映射测试。
- **Rust 面沿用既有单测先例**：runtime 工厂/kind 枚举分支、托管 Runtime 安装规格与完整性检查（对齐 Codex CLI 托管化 ticket 的测试形态）。
- **前端仅更新注册表驱动的既有组件测试**（智能体选择器、品牌图标、供应商校验），不为 pi 写新交互测试——UI 行为全部由注册表数据驱动。
- 好测试的标准：只测跨边界的可观察行为（协议帧、事件序列、超时与退出行为），不断言内部调用顺序；fake 上时间可控。全量套件（根 + sidecar + mobile）与 Rust fmt/clippy/check 作为合入 gate。

## Out of Scope

- **`~/.pi` 存量会话导入**（二期，已完成 2026-09-03：见 issues/08）：格式已调研（JSONL，首行 `type:"session"` 头，`message`/`model_change`/`thinking_level_change` 条目；路径受 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 及 settings.json `sessionDir` 影响），实施时按现有按 kind 历史导入模式追加。
- **审批 / ask-user**（已完成 2026-09-04：经临时扩展 + `extension_ui_request` 桥接实现，见 issues/09）：原定不实现 `extension_ui_request` 桥接；pi 会话无 Interactive Request。
- **自研 pi 扩展**：不生成临时扩展（system prompt 注入、会话树条目捕获、自定义扩展命令均不做）。
- **会话树 rewind / fork-to-entry**（已完成 2026-09-04：复用现有 rewind 管线经 sidecar 调 pi 原生 `fork` 实现，见 issues/10）：0.73.1 RPC 无 `get_tree`/`navigateTree`（fork+`get_fork_messages` 即完整 RPC 面）；文件快照 rewind 本就不支持。
- **MCP 传递**：不适用——锁定的 pi 0.73.1 没有任何 MCP 能力（README 明确 "No MCP"，无 `--mcp-config` flag、配置无 mcpServers、CHANGELOG 零记录；作者主张以 Skills + 带 README 的 CLI 工具替代）。`McpApps` 勾选面也不含 pi。将来若升级 pin 后 pi 提供原生 MCP，CodeMUX 侧应同步到托管 `piConfigDir`（经 `PI_CODING_AGENT_DIR` 注入，与 ADR 0005 硬隔离一致），届时再立项。
- **pi 扩展命令作为 slash 命令**：不接 `get_commands`（会与 CodeMUX 本地注册重复）；仅内置 `/compact`。skills 命令已通过 SkillAdapter 同步接入（见 issues/11），pi 的 `/skill:<name>` 命令由 CodeMUX 本地注册渲染。
- **移动端 pi 专属 UI**：不含移动端新建 pi 会话的专属适配。
- **pi 专属输出**：`/share`、`export_html`、bash 直连 RPC 等不暴露。

## Further Notes

- **参考实现**：paseo 仓库已完成同路线接入，可直接对照协议细节与坑位——通用 JSONL RPC 传输（超时/关闭策略）、`rpc-types.ts`（协议类型与 COMPAT 注释）、runtime/事件映射/usage 轮询/会话描述符各模块。其「运行时生成临时扩展」与「ask-user 经 extension_ui」是二期审批/rewind 的现成参考。
- **已知坑位清单**（来自 paseo 实测，实施时须复核）：pi ≤ 0.83 `message_update` 为累积全文（去重 COMPAT，设版本下限后移除）；旧版无 `get_session_stats`（回退 `get_state`）；Node `readline` 切帧不合规；pi 输出可能含 ANSI 转义（展示层剥离）；托管安装必须锁定已知好版本而非追最新。
- **ADR 关系**：遵循 0002（日志）、0003（事件协议）、0004（turn 超时）、0005（自有 Model Provider）、0006（附件富化）、0008/0009（Companion）；进程模型与 0010（Codex app-server 传输）同构。会话内 Agent Kind Switch 已随 Session Timeline 重构撤销（撤销 ADR 0007），故本规格不含切换语义；如需将 pi 传输层决策正式成文，可在实施时于 ADR 0010 追加附录或后补简短 ADR。
- **建议实施顺序**：传输层 + fake-pi 基建 → 单会话 prompt 往返（模型/思考等级/中断）→ 会话映射与恢复 → 用量与 compact → 托管 Runtime 与前端注册 → Fork/Delete 与移动端回归。
