# 多智能体运行时切换调研（2026-08-15）

## 结论先行

市场主流编码 Agent 产品几乎都把「换模型」和「换运行时」分开。换模型发生在**同一个 harness** 里（同一套工具、权限、session ID）；换运行时（Claude Code / Codex / OpenCode 这类独立 agent 产品）几乎一律意味着**新 thread**，而不是在同一条对话里热切换。最接近 CodeMUX 目标的产品是 Zed：Agent Panel 用 ACP 托管 Claude / Codex / OpenCode 等外部运行时，但「New Thread」菜单在创建时选定 agent，线程与运行时绑定；跨 agent 的历史导入是「把对方的 session 拉进 Thread History」，不是把一条对话的后端从 Claude 换成 Codex。Warp 则更极端：把各 CLI agent 当成独立终端标签并行跑，会话彼此隔离。

三个 CodeMUX 已托管运行时都支持**本运行时内** resume / fork，但不能共享原生 session ID：

| 运行时 | 原生 ID | Resume | Fork | 导入外来历史 |
| --- | --- | --- | --- | --- |
| Claude Code / Agent SDK | UUID session，磁盘 JSONL | `resume` / `--continue` | `forkSession` / `--fork-session` / `/branch` | **无官方 API**；官方建议把分析结果当应用状态塞进新 prompt |
| Codex | `thread.id`（如 `thr_123`） | `resumeThread` / `thread/resume` | app-server `thread/fork`（TS SDK 未公开 fork） | `thread/inject_items` 可追加 Responses API items |
| OpenCode | `ses_…` session ID | `--session` / SDK `session.prompt` | `POST /session/:id/fork` / `session.fork` | `session.prompt({ noReply: true })` 注入上下文；CLI `opencode import` 导入本产品 JSON/share URL |

**对 CodeMUX 的推荐（主方案）**：采用 **Pattern F（活跃运行时指针 + 每 runtime 一条原生 mapping）+ Pattern C（应用拥有权威 transcript，切换时重建）**。

- 一条 CodeMUX 对话保持不变；`sessions.agent_kind` 从「永久绑定」改为「当前活跃运行时」。
- 已有 `agent_session_mappings UNIQUE(app_session_id, agent_kind)` 正好承载「一会话对每个 runtime 最多一条原生 session」。
- 切换只允许在 **idle**（本轮 `turn_outcome` 已结束，且无未完成权限/问答）。
- 默认**不 resume 旧的原生 session**（它缺了另一 runtime 上发生的回合）；每次切换 **mint 新的原生 session**，用 CodeMUX Events 生成 **摘要 + 最近若干轮用户/助手文本** 注入目标 runtime，再覆盖 mapping。
- UI 在输入框旁做 runtime 切换确认，并写入 `system_event`（`subtype=runtime_switch`）。
- **Fallback**：沿用现有 Fork 管线，做成「用另一 runtime 开子会话」（Pattern D），不改当前对话的 `agent_kind`。

不要声称：原生 session ID 可跨 runtime 共用；工具调用/权限审批记录可无损重放；Claude `permissionMode` 与 Codex `approvalPolicy` / OpenCode `permission` 一一对应。

---

## 1. 范围与方法

### 1.1 问题

CodeMUX 已在同一桌面应用中托管三个**编码 Agent 运行时**（不是三个 LLM）：`claude_code`（Claude Agent SDK）、`codex`（Codex SDK）、`opencode`（OpenCode 官方 SDK）。现行产品规则是：agent 在新建对话时选定，之后永久绑定 `sessions.agent_kind`；明确非目标是「不允许在已有 session 内切换绑定 agent」（见 `docs/superpowers/specs/2026-06-10-multi-agent-codex-integration-design.md`）。本调研回答：若要在**同一条对话**中在三个 runtime 之间切换并继续工作，市场怎么做、三个 SDK 允许什么、CodeMUX 现有缝可以怎么用。

### 1.2 方法

优先使用官方文档、官方 SDK/CLI 参考、GitHub 源码与第一方 API/spec。次要使用第一方社区（Cursor 论坛员工回复）。博客与第三方对比矩阵只作线索，不作为事实依据。无法核验的 API 标为 **未核实**。

检索日期：2026-08-15。文档站点可能随时改版；下文引用的是当时抓取到的页面。

### 1.3 术语

- **运行时 / runtime / harness**：独立的编码 Agent 产品及其工具协议、权限模型、原生 session 存储（Claude Code、Codex、OpenCode）。
- **模型切换**：同一 runtime 内更换 LLM（Claude Sonnet → GPT，或 OpenCode 的 `provider/model`）。
- **会话身份**：应用层 conversation（CodeMUX `sessions.id`）vs provider 原生 session（Claude UUID / Codex `thread.id` / OpenCode `ses_…`）。
- **Handoff**：编排框架里把控制权交给另一个 agent（通常仍在同一进程、同一消息列表）；与「换 harness」不是一回事。

---

## 2. 市场与开源产品怎么做

### 2.1 编码 Agent 产品对照表

下表区分两件事：**同一 harness 内换模型/模式**，以及 **托管多个独立 coding runtime**。

| 产品 | 是否托管多个 coding runtime | 换模型 | 对话中途换 runtime | 会话身份 | 历史交接 | 模式 |
| --- | --- | --- | --- | --- | --- | --- |
| **Cursor** | 否。一个 Cursor Agent；多模型走 Cursor 自己的工具层 | 输入框模型选择器；部分推理模型会锁死切换 | **不支持换 harness**。Fork Chat 复制历史后可在副本上换模型 | 应用 conversation；后端按 Cursor prompt 重建 | Fork 复制至 fork 点的历史 | B + D |
| **Continue** | 否。同一 Agent 循环；Chat / Plan / Agent 是工具策略 | `/model` 或模型选择器 | 不换 runtime；可换 mode | 应用 session；CLI `/resume` `/fork` | 同一 transcript | B（mode）+ D（fork） |
| **Cline** | 否。一个 Cline harness；`providerId`+`modelId` 可换 | 配置/SDK 换模型 | 不换 runtime。SDK `restore(messages)` 替换历史 | `ClineCore` session vs 轻量 `AgentRuntime` | 应用拥有 messages | C（应用历史）+ B |
| **OpenHands** | 否。一个 agent-server；`RUNTIME` 是 sandbox 后端不是另一套 coding CLI | Settings 换 LLM | 未发现跨 Claude/Codex CLI 热切换 | Conversation + workspace；Cloud 有恢复延迟 | 工作区/对话持久化 | A + G |
| **Aider** | 否。一个 aider 循环 | 聊天中 `/model` | 不换 runtime | 聊天 session；git commit 是记忆 | 文件 + git | B + G |
| **Goose** | 否。一个 goose；可换 provider/model | 配置/session 级模型 | 不换 runtime | Desktop/CLI 共用 session DB；`--resume` / `--fork` | 复制 messages 到新 session | A + D |
| **Amp** | 否。Amp 自己的 thread；mode 换模型+工具+prompt | `mode`（low/medium/high/ultra） | 不换 runtime。可用 `read_thread` 引用别的 thread | Thread ID `T-…`；SDK `continue: true \| threadId` | 新 thread @ 旧 thread | A + B + 引用式交接 |
| **Zed** | **是（最接近）**。Zed Agent + ACP External Agents（Claude、Codex、OpenCode、Copilot、Gemini CLI 等） | Zed Agent 可换模型；External Agent 的模型通常由该 agent 自己管 | **新 thread 时选 agent**，不是同一 thread 换 agent。可 Import Threads 从外部 agent 拉历史 | Zed thread vs agent-native session；ACP 边界 | 导入为归档 thread；打开后在**原 agent** 上继续 | A（每 thread 绑一个 agent）+ 导入 |
| **GitHub Copilot** | Copilot Chat / Copilot CLI / coding agent 是 Copilot 产品面，不是同时托管 Claude Code+Codex | resume 时可换 `model` | 不换到 Claude Code/OpenCode。CLI `/fork`（实验） | Copilot `session_id`；磁盘 `~/.copilot/session-state/` | 本产品 resume/fork | A + B + D |
| **Claude Code** | 否。一个 Claude Code；`--agent` 是 Claude 的 subagent/persona | 会话恢复时带上原模型；可用 `--model` 覆盖 | `/resume` 换的是**另一条 Claude 会话**，不是 Codex | Claude session UUID + JSONL | resume 复用 ID；fork 新 ID 拷历史 | A + B + D |
| **OpenAI Codex** | 否。一个 Codex；`/model` 换模型。app-server 可 **import 外部 agent 的 config/skills/MCP/sessions**（迁移，不是热切换） | 恢复时若模型不同会警告并一次性注入 model-switch instruction | 不在一条 thread 里变成 Claude Code | `thread.id`；fork 后 `sessionId` 可能仍指向 root | `thread/fork` 拷历史；`thread/inject_items` | A + B + D |
| **OpenCode** | 否（作为产品）。Tab 切换的是 OpenCode **primary agent**（Build/Plan），不是换到 Claude Code 二进制 | `--model provider/model`；prompt 可带 model | 同一 OpenCode session 内可换 primary agent / 调 subagent | `ses_…`；fork 出 child session | fork 拷贝 messages；`noReply` 注入；`import` JSON | A + 内部 agent 切换 + D |
| **Warp** | **是（并行宿主）**。Warp Agent + 一等公民第三方 CLI（Claude Code、Codex、OpenCode、Amp、Copilot、Cursor CLI、Gemini、Goose 等） | Warp Agent 有模型选择；CLI agent 用各自 TUI | **并行标签/终端**，不是一条对话换后端 | 各 CLI 自己的 session；Warp conversation token 只用于 Warp Agent | 无跨 CLI transcript 合并 | 并行 A |
| **Void / PearAI** | 未核实为多 runtime 宿主。PearAI 基于 Continue 一类聊天壳 | 模型选择 | 视为 Continue 同类（Pattern B） | — | — | B（未深挖） |
| **Cherry Studio** | 多 **LLM 供应商/模型** 的桌面客户端，不是 Claude Code/Codex/OpenCode harness 宿主 | 会话内换模型是产品常规能力 | **未发现** coding-runtime 热切换的官方设计 | 应用 conversation + `Model.name` 展示管线 | 应用侧历史 | B |
| **LangBot / Dify / Coze** | 工作流/机器人编排，不是 IDE coding-agent 多 runtime。按任务要求降优先，不展开 | — | 与 CodeMUX 问题不同构 | — | — | E（工作流） |

#### Cursor

Cursor 官方文档把产品定位为「一个 coding agent」，模型表列 Claude / Composer / Gemini / GPT / Grok 等，走 Cursor 的 Agent 工具层，而不是把 Claude Code CLI 与 Codex CLI 嵌进同一条 chat（[Cursor Docs 首页 / Models](https://docs.cursor.com/agent/overview)）。第一方论坛员工说明：

- Fork Chat 从某条消息复制历史到新 chat，上下文保留到 fork 点（[Cursor Forum: Question about Fork Chat](https://forum.cursor.com/t/question-about-fork-chat/165793)）。
- `/fork` 与聊天列表 ⋯ 菜单的 Fork Chat 克隆当前检查点（[Cursor Forum: Fork Chat bug](https://forum.cursor.com/t/fork-chat-follow-up-in-forked-thread-re-answers-the-previous-turn-as-if-the-assistant-reply-was-never-received/166177)）。
- 部分推理模型（如 Opus High）会提示 “Switching models is unavailable… Start a new conversation”；建议 Fork 后再换模型（[Cursor Forum: switching models unavailable](https://forum.cursor.com/t/switching-models-is-unavailable-in-this-conversation-start-a-new-conversation-to-use-a-different-model/157132)）。
- Subagent 属于启动它的那条 chat，不能把另一条已有对话接成同一个 stateful subagent（[Cursor Forum: subagent across chats](https://forum.cursor.com/t/can-i-get-an-agent-to-start-using-another-existing-conversation-as-a-basis-for-a-subagent-and-follow-up-with-the-same-subagent/165233/6)）。

结论：Cursor 是 **Pattern B（同 harness 换模型）+ Pattern D（fork）**。没有「同一 conversation 换 Claude Code/Codex runtime」。

#### Continue.dev

Agent / Plan / Chat 是同一界面下的**工具可用性**差异，不是三个 runtime（[How Agent Mode Works](https://docs.continue.dev/ide-extensions/agent/how-it-works)）。CLI TUI 提供 `/model`、`/resume`、`/fork`、`/compact`（[TUI Mode](https://docs.continue.dev/cli/tui-mode)）。新 session 用快捷键清空上下文（[How Chat Works](https://docs.continue.dev/ide-extensions/chat/how-it-works)）。

#### Cline / Roo Code

Cline SDK 把「换模型」做成 `AgentRuntimeConfig` 的 `providerId`/`modelId`。关键 API：`restore(messages)`「Replaces conversation history and resets runtime state while preserving tools, hooks, model…」（[Agent API](https://docs.cline.bot/sdk/reference/agent)）。`ClineCore` 负责 session 持久化；轻量 `Agent` 则让应用自己管历史（[ClineCore](https://docs.cline.bot/sdk/clinecore)）。这是 **应用拥有 canonical messages** 的 Pattern C 雏形，但仍是**一个** Cline runtime。Cline 也可作为 ACP server 被 Zed 等客户端托管（[ACP](https://docs.cline.bot/usage/acp)）——那时会话身份在客户端 thread，运行时仍是 Cline。

Roo Code 是 Cline 生态 fork，未单独核实其是否增加跨 harness 切换；按 Cline 同类处理。

#### OpenHands / All Hands

V1 配置里 `RUNTIME=docker|process|remote` 选择的是 **sandbox 执行后端**，不是 Claude Code vs Codex CLI（[Configuration Options](https://docs.all-hands.dev/usage/configuration-options)）。Agent 跑在 agent-server 镜像里。Cloud 文档描述 conversation / workspace 保留与 runtime 冷却后恢复变慢（[OpenHands Cloud](https://docs.all-hands.dev/zh-Hans/modules/usage/cloud/openhands-cloud)）。属于 **单 runtime + 工作区记忆（G）**。GUI 页本次抓取超时，未核实是否有「换 agent 实现」的 UI。

#### Aider

官方 usage：启动时 `--model`，聊天中 `/model` 切换；编辑过的文件进 git commit，`/undo` 回滚（[Usage](https://aider.chat/docs/usage.html)）。会话薄、**git 是记忆**（Pattern G）。没有第二套 coding CLI。

#### Block Goose

官方 CLI：`goose session --resume`；`--fork` 必须与 `--resume` 一起用，「Create a new duplicate session with copied history」（[goose-cli-commands.md](https://github.com/block/goose/blob/58f3cc9e/documentation/docs/guides/goose-cli-commands.md)）。Desktop 侧栏切换的是 **goose 自己的 chat sessions**，Desktop 与 CLI 共用同一 session 数据库（[session-management.md](https://github.com/block/goose/blob/58f3cc9e/documentation/docs/guides/sessions/session-management.md)）。Pattern A + D。

#### Amp（Sourcegraph）

Thread 即上下文窗口。SDK：`options.continue: true` 或 `continue: 'T-abc123-def456'`（[Amp SDK](https://ampcode.com/manual/sdk)）。`mode` 同时切换模型、系统提示和工具集。跨 thread 交接用 `@` 引用 + `read_thread` 工具让第二个模型抽取要点，而不是合并两条 thread 的原生 ID（[Context Management](https://ampcode.com/guides/context-management)）。Pattern A + B + 引用式摘要交接。

#### Zed Agent Panel（关键对照）

官方明确：

> External Agents are agents that integrate with Zed through the Agent Client Protocol (ACP). Zed hosts the thread in the Agent Panel… while the External Agent usually owns its own runtime, auth, model selection, tools, and native configuration.  
> （[External Agents](https://zed.dev/docs/ai/external-agents)）

New Thread 菜单：选 **Zed Agent 或任一已安装 External Agent** 开新线程（[Agent Panel](https://zed.dev/docs/ai/agent-panel)）。「New From Summary」只适用于 **Zed Agent**，用当前对话摘要播种新线程。Steering 也只适用于 Zed Agent，「Zed can't detect turn boundaries for external agents」。

配置边界表（同页）：Zed Skills / Profiles **不**自动作用于 External Agent；MCP 可能经 ACP 转发，也可能读 agent 自己的 MCP 配置。

**Import Threads**：从已配置 External Agent 经 ACP 拉取尚未在历史中的 sessions，导入为**归档**条目；打开后在原 agent 上继续。没有工作目录的 session 会被跳过。这是「把别人的原生会话登记进宿主」，不是「把当前 thread 的 backend 从 Claude 换成 Codex」。

ACP Registry 列出 Claude、Codex、OpenCode、Copilot、Gemini CLI 等（[ACP Registry 博文](https://zed.dev/blog/acp-registry)）。这是市场上与 CodeMUX 最像的 **多 runtime 宿主**，产品选择是 **Pattern A：一 thread 一 runtime**。

#### GitHub Copilot

Copilot CLI：`--continue` / `--resume` / 会话内 `/resume`；实验模式 `/fork` `/branch`（[CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)；[chronicle / resume](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)）。Copilot App：`/fork` 在最新 turn fork；`/restart-session` 重启但保留历史（[slash commands](https://docs.github.com/en/copilot/reference/github-copilot-app-reference/slash-commands)）。

Copilot SDK：自备 `sessionId` 才能 resume；`resumeSession` 可换 `model`、tools、MCP、skills；状态在 `~/.copilot/session-state/{sessionId}/`；**API key 不落盘**（[Session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence)）。仍是 Copilot 一个 runtime。

#### Claude Code

见第 4 节。产品内 `/resume` 切换的是另一条 Claude 会话；`--agent` 在 resume 时可换 Claude 定义的 agent persona，不是换 Codex。

#### OpenAI Codex

见第 4 节。`/model` 与 resume 时换模型。`externalAgentConfig/import` 用于从其他 agent **迁移** config/skills/MCP/sessions，不是热切换后端（[Codex App Server](https://developers.openai.com/codex/app-server)）。

#### OpenCode

见第 4 节。Tab 切换 Build/Plan 是 **同一 OpenCode 进程内的 primary agent**（[Agents](https://opencode.ai/docs/agents)）。作为被 Zed/Warp 托管的 ACP/CLI agent 时，会话仍归 OpenCode。

#### Warp

Warp 对第三方 CLI 做「universal agent support」：自动检测 Claude Code、Codex、OpenCode、Amp、Copilot CLI、Cursor CLI、Gemini CLI、Goose 等，提供富输入框、code review、Remote Control，但 **各 agent 仍是独立进程/标签**（[Third-party CLI agents](https://docs.warp.dev/agent-platform/cli-agents/overview/)）。Warp 自己的 CLI 用 `warp --resume CONVERSATION_TOKEN` 和 `/handoff` 把 **Warp Agent** 对话交给 cloud agent（[Warp CLI reference](https://docs.warp.dev/cli/reference/)）。这是并行宿主，不是一条 transcript 换 runtime。

#### Void / PearAI / Cherry Studio

Cherry Studio 调研（仓库内 `docs/research/cherry-studio-model-display-name-rules.md`）只涉及多供应商模型展示名，不涉及 Claude Code/Codex harness。Cherry 是多模型聊天壳（Pattern B）。Void/PearAI 未找到「多 coding runtime 热切换」的官方说明，按 Continue 同类降优先。

### 2.2 编排框架中的 Handoff / Supervisor

这些框架解决的是 **同一应用进程里多个 LLM agent 的控制权**，通常共享一个消息列表或显式过滤后的消息列表。它们**不是** Claude Code ↔ Codex 这种异构 harness 切换，但「用户看到一条对话、底下 active_agent 指针在变」对 CodeMUX UI 有借鉴。

#### LangGraph / LangChain handoffs

官方：handoff 通过工具更新 `current_step` / `active_agent`；可用单 agent + middleware 换 prompt/工具，或多 subgraph + `Command.PARENT` 跳节点（[Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)）。跨 subgraph 必须保证 tool_call 与 ToolMessage 成对，否则历史非法。官方建议多数场景不要把子 agent 全文塞给下一个 agent，而是只传 handoff 对，或在 ToolMessage 里摘要。`create_handoff_tool(agent_name=...)` 生成 `transfer_to_<name>`（[create_handoff_tool](https://reference.langchain.com/python/langgraph-supervisor/handoff/create_handoff_tool)）。

对 CodeMUX：可借鉴 **active_agent 指针 + 切换时写入一条系统/工具说明**；不要借鉴「把 Claude 的 tool_use 块原样喂给 Codex」。

#### OpenAI Agents SDK / Swarm 风格

两种模式（[Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)）：

1. **Agents as tools**：manager 保持对用户可见对话，专家当工具。
2. **Handoffs**：triage 把对话交给专家，专家成为本 turn 的 active agent。

Handoff 对 LLM 表现为 `transfer_to_<agent>` 工具；默认可看到完整先前历史，可用 `input_filter`（如 `remove_all_tools`）或 `nest_handoff_history` 做摘要分段（[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)）。Handoff **发生在一次 `Runner.run` 内**。

对 CodeMUX：Pattern E（专家当工具）适合「让 Claude 调一个只读探索子 agent」，不适合替换整个 harness。若做用户驱动切换，更接近「结束当前 run，换 adapter，带过滤后的历史开新 run」。

#### Microsoft AutoGen / Magentic-One

Magentic-One：Orchestrator 外环维护 Task Ledger、内环维护 Progress Ledger，把子任务派给 WebSurfer / FileSurfer / Coder / ComputerTerminal；用户面对的是编排器，不是自己点选 runtime（[Magentic-One](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。这是 Pattern E，且各 specialist 仍在 AutoGen 进程内。

#### CrewAI

`Process.sequential`：任务按列表，前一输出当后一 context。`Process.hierarchical`：manager_llm / manager_agent 分配任务（[Processes](https://docs.crewai.com/en/concepts/processes)）。任务级交接，不是 IDE 对话热切换。

#### Google ADK

工作流类型含 graph / dynamic / collaborative（coordinator + sub-agents）/ template（sequence、loop、parallel）；另有实验性 Agent Routing 在运行时用 router 选 agent（[ADK multi-agent](https://google.github.io/adk-docs/agents/multi-agents/)）。仍是框架内组合，不是异构 CLI harness。

#### Anthropic Claude Agent SDK 多 agent

官方 session 文档把 fork/resume 限定在 **Claude 自己的 session 文件**（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)）。`--agent` / subagent 是 Claude Code 内部 persona 与工具限制（[Manage sessions](https://code.claude.com/docs/en/sessions) 的 “Agent” 恢复项）。没有「把 session 交给 Codex」的 API。

#### CAMEL / MetaGPT / ChatDev

角色扮演/软件公司模拟，会话交接是角色消息传递。对 CodeMUX 的异构 SDK 切换没有可迁移的 session ID 协议，不展开。

---

## 3. 可复用模式

### Pattern A：对话永久绑定一个 runtime

**谁用**：CodeMUX 现行规则；Zed 每个 thread；Goose/Amp/Aider/OpenHands 作为单产品；Warp 每个 CLI 标签；Claude Code / Codex / OpenCode 各自的 CLI。

**存什么**：一个应用 session ↔ 一个 `agent_kind` ↔ 一条原生 session ID。

**交接**：无。换 agent = 新对话。

**失败模式**：用户想「这段用 Codex 收尾」必须复制粘贴或 @ 旧对话；上下文丢失或重复付费。

### Pattern B：同一 runtime 内换模型（同一 session ID）

**谁用**：Cursor 模型选择器；Continue `/model`；Aider `/model`；OpenCode `--model` / prompt.model；Codex `/model` 与 resume 时换模型；Copilot `resumeSession({ model })`；Claude 恢复时可用 `--model` 覆盖。

**存什么**：同一原生 session；模型是 session 元数据或下一 turn 的覆盖项。

**交接**：通常整段 transcript 原样再发给新模型。Codex：若 resume 模型与 rollout 记录不同，发警告并一次性 model-switch instruction（[App Server](https://developers.openai.com/codex/app-server)）。Cursor：部分 reasoning 轨迹无法被其他模型消费，于是锁切换。

**失败模式**：工具结果/思考块格式不兼容；prompt cache 失效；权限/模式不随模型迁移。

### Pattern C：用户换 runtime；应用拥有权威 transcript；新 runtime 拿到重建后的 prompt/历史

**谁用**：Cline `restore(messages)`（仍是 Cline 内）；编排框架的 `input_filter` / 摘要 handoff；Amp `read_thread` 抽取；Claude 官方跨机建议「不要依赖 session resume，把分析结果当应用状态塞进新 prompt」（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)）；Zed 「New From Summary」（仅 Zed Agent）。

**存什么**：宿主 canonical 消息；原生 session 是派生物，可丢弃重建。

**交接**：摘要、最近 N 轮纯文本、或过滤掉 tool 对的消息列表。

**失败模式**：摘要丢细节；伪造的 tool 历史导致目标模型 hallucinate 已执行的编辑；过长重建撑爆窗口。

### Pattern D：fork-on-switch（新 session，拷历史）

**谁用**：Claude `/branch` `--fork-session`；Codex `thread/fork`；OpenCode `session.fork`；Continue `/fork`；Goose `--fork`；Cursor Fork Chat；Copilot `/fork`；CodeMUX 现有 conversation fork。

**存什么**：父子 lineage；新原生 ID；拷贝到边界为止的历史。

**交接**：同 runtime 内是原生拷贝（工具块完整）。跨 runtime 的「fork」其实是 D + C：新应用 session + 重建。

**失败模式**：Claude fork 不拷「Allow for this session」到新进程；Codex 拒绝 in-progress `lastTurnId`；OpenCode `messageID` 边界是「该 ID **之前**」，不含该条（CodeMUX 已踩过，见 fork 规格）。

### Pattern E：编排器把专家当工具；用户停留在一条对话

**谁用**：OpenAI Agents SDK `Agent.as_tool()`；Magentic-One Orchestrator；LangGraph supervisor；OpenCode primary 调 subagent（`@general` / Task 工具）；Claude Code subagents；Amp subagents / Oracle。

**存什么**：一条用户对话；子 agent 常为 child session 或无状态工具调用。

**交接**：任务说明 + 可选过滤历史。OpenCode 子 session 可用 `session_parent` / `session_child_cycle` 导航，但那是同一产品内。

**失败模式**：子 agent 不继承父会话；用户无法「整个后端换成 Codex」。与「用户驱动 runtime 切换」目标不同。可作为补充（只读探索），不能替代切换。

### Pattern F：并行映射 — 一个应用 session，多个 provider session ID，active runtime 指针

**谁用**：CodeMUX **数据层已经具备** `UNIQUE(app_session_id, agent_kind)`（`src-tauri/src/db/schema.rs`），但产品层尚未把 `agent_kind` 当指针用。编排框架的 `active_agent` 是同进程变体。未见主流 IDE 用 F 把 Claude JSONL 与 Codex thread **同时**挂在同一 UI 对话上并来回切。

**存什么**：`app_session_id` + `active_agent_kind` + 每 kind 一条 `agent_session_id`。Canonical 事件仍在应用库。

**交接**：切到 B 时，要么 resume B 的旧原生 session（缺 A 上的新回合 → **陈旧**），要么 mint B 的新原生 session 并注入重建历史（推荐）。

**失败模式**：误 resume 陈旧原生 session；mapping 覆盖后旧原生 session 变孤儿；两个 runtime 同时写同一工作区。

### Pattern G：共享工作区 / git 当记忆，对话很薄

**谁用**：Aider（每步 commit）；OpenHands workspace；Claude/Zed worktree 隔离；很多 CLI「新开一个 session 但 cwd 相同」。

**存什么**：文件与 git；对话只是当前任务。

**交接**：新 runtime 靠读磁盘/diff 恢复，不靠 transcript。

**失败模式**：未提交更改、计划文本、未落地的决策丢失；用户仍觉得「对话断了」。

---

## 4. Claude Code / Codex / OpenCode 原生存储与切换约束

### 4.1 Claude Code / Claude Agent SDK

**能否 resume？** 能。CLI：`claude --continue`、`claude --resume [id|name]`、会话内 `/resume`（[Manage sessions](https://code.claude.com/docs/en/sessions)）。SDK：`options.resume = sessionId` 或 TypeScript `continue: true`（最近一条）（[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)）。

**能否注入外来历史？** **没有官方「import foreign transcript」API。** 官方跨机方案：`sessionStore` 适配器、搬 JSONL 文件、或「不要依赖 resume，把需要的结果当应用状态放进新 prompt」。JSONL 格式被明确标为内部、跨版本会变，脚本直接解析可能随时坏掉（[Manage sessions § transcripts](https://code.claude.com/docs/en/sessions)）。`/export` 是给人看的纯文本，不是可再导入的 session。

**能否 fork？** 能。CLI：`--fork-session` 配 `--resume`/`--continue`；会话内 `/branch`。SDK：`resume` + `forkSession: true` / `fork_session=True`。Fork 得到新 session ID，原 ID 不变。`/branch` 在**同一进程**内拷 transcript 并切换写入目标，因此「Allow for this session」权限会带上；`--fork-session` 是新进程，**不**继承这些授权（[Manage sessions § branch](https://code.claude.com/docs/en/sessions)）。

**原生 session 标识？** UUID。磁盘：`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`（可用 `CLAUDE_CONFIG_DIR`）。SDK 从 `ResultMessage.session_id` 或 init `SystemMessage` 读取。

**消息/历史格式？** JSONL 每行一条内部对象（message / tool use / metadata）。SDK 另有 `getSessionMessages()` / `listSessions()`。CodeMUX 已用截断 JSONL + SDK fork 实现任意历史点 fork（`docs/superpowers/specs/2026-08-08-conversation-fork-feature.md`）。

**Compact / 摘要继续？** `/compact`；Pro/Max 上长时间不活跃且 >100k tokens 的 resume 会对话框：「Resume from summary」（立即 compact）vs 「Resume full session as-is」（[Manage sessions](https://code.claude.com/docs/en/sessions)）。这是**同 runtime 内**的摘要交接，不是跨产品。

**权限 / plan-mode 对天真切换的破坏：**

- Resume **会**恢复 conversation、模型（有例外）、agent persona、多数 permission mode。
- **`plan` 和 `bypassPermissions` 永不恢复**；bypass 必须再次用启动 flag 或 settings。`auto` 仅在账号仍满足条件时恢复。可用 `--permission-mode` 覆盖（[Manage sessions § what restores](https://code.claude.com/docs/en/sessions)）。
- `--mcp-config`、`--settings`、`--plugin-dir`、`--fallback-model`、`--add-dir` **不会**随 resume 恢复，必须再传。
- 模式包括 `default`/`manual`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`（[Permission modes](https://code.claude.com/docs/en/permission-modes)）。与 Codex sandbox/approval、OpenCode allow/ask/deny **不是同一套枚举**。

**MCP / skills：** Claude 读 `settings.json`、项目 `.claude`、skills。OpenCode 甚至能读 `.claude` skills，除非 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`（[OpenCode CLI env](https://opencode.ai/docs/cli/)）。切换到 Claude 时必须按 Claude 的加载规则重新加载，不能假定 Codex MCP 列表仍在。

**对跨 runtime 的含义：** 切到 Claude 只能 `query()` 新 session 或 resume **已有 Claude JSONL**。要把 Codex 对话交给 Claude，只能：写临时 JSONL（依赖内部格式，官方不支持）或把摘要/文本放进第一条 prompt。

### 4.2 OpenAI Codex

**能否 resume？** 能。TS SDK：`codex.resumeThread(threadId)`（[Codex SDK](https://developers.openai.com/codex/codex-sdk)）。App-server：`thread/resume`（[App Server](https://developers.openai.com/codex/app-server)）。CLI：`codex resume`（[Developer commands](https://developers.openai.com/codex/developer-commands)）。

**能否注入外来历史？** **部分能。** `thread/inject_items`：「append raw Responses API items to a loaded thread's model-visible history without starting a user turn」，写入 rollout，后续模型请求会带上。示例是 `role: assistant` 的 Responses `message` item（[App Server § inject](https://developers.openai.com/codex/app-server)）。这不是「导入 Claude JSONL」；必须先把 CodeMUX Events 编成 Responses items。TS SDK 文档只展示 start/resume/run，**未**记录 inject；CodeMUX 若要用，应走 app-server（项目 fork 规格已证明 TS SDK 0.146.1 连 fork 都没暴露）。

**能否 fork？** App-server `thread/fork`：`threadId` + 可选 `lastTurnId`（含该 turn）；可 `ephemeral: true`。返回新 `thread.id`，`forkedFromId` 指向源。**注意官方示例**：非 ephemeral fork 的 `sessionId` 可能仍是 **root thread id**（`id: thr_456, sessionId: thr_123`）（[App Server](https://developers.openai.com/codex/app-server)）。拒绝 in-progress `lastTurnId`。GitHub issue 显示 TS SDK 仍缺 fork 覆盖（[#29859](https://github.com/openai/codex/issues/29859)）——这是 issue 描述，以 app-server 文档为准。

**原生标识？** `thread.id`（文档示例 `thr_123`）。Core primitives：Thread ⊃ Turn ⊃ Item。

**历史格式？** 本地 JSONL rollout；`thread/read`、`thread/turns/list`（experimental）。Item 含 user/agent message、command、file change、tool call 等。

**Compact？** `thread/compact/start` 立即返回 `{}`，进度走 `turn/*` `item/*`。

**权限差异：** `approvalPolicy`、`sandbox`（read_only / workspace_write / full_access）。Turn 级可覆盖 sandbox。CodeMUX 已映射：plan mode 强制 `read-only` + `on-request`（`docs/superpowers/specs/2026-06-29-agent-permission-approval-alignment-design.md`）。切到 Codex 必须按 Codex 语义重建，不能把 Claude `plan` 当同一状态恢复（Claude 自己 resume 也不恢复 plan）。

**MCP / skills：** 配置里 `required` MCP 初始化失败则 `thread/start` 和 `thread/resume` 失败。`dynamicTools` 可写入 rollout 并在 resume 时恢复。Skills 通过 turn input 的 `skill` item + `$name` 文本调用。`externalAgentConfig/import` 可迁移其他 agent 的 skills/MCP/sessions——那是**配置迁移**，不是把 Claude 对话接到当前 thread。

**对跨 runtime 的含义：** 切到 Codex = `thread/start`（或 fork 一条空/注入后的 thread）+ `inject_items` 放摘要/对话文本 + `turn/start`。不要 resume 切换前的旧 Codex thread，除非用户明确接受「回到切走之前的 Codex 世界线」。

### 4.3 OpenCode

**能否 resume？** 能。CLI：`--session`/`-s`、`--continue`/`-c`（[CLI](https://opencode.ai/docs/cli/)）。SDK：对已有 `session.id` 调 `session.prompt`（[SDK](https://opencode.ai/docs/sdk)）。Server：`GET/POST /session`（[Server](https://opencode.ai/docs/server)）。

**能否注入外来历史？** **部分能。**

1. `session.prompt` / `POST /session/:id/message` 的 `noReply: true`：「returns UserMessage (context only)」，「Inject context without triggering AI response」（[SDK](https://opencode.ai/docs/sdk)；[Server Messages](https://opencode.ai/docs/server)）。适合把摘要写成用户/系统上下文。
2. CLI `opencode import session.json` 或 share URL（[CLI](https://opencode.ai/docs/cli/)）。这是 **OpenCode 自己的导出 JSON**，不是 Claude/Codex 格式。跨产品导入需 CodeMUX 先编成 OpenCode session JSON——**编解码稳定性未在本次对照 OpenAPI 逐字段核实**，实施前必须对当前托管 runtime 版本做 fixture。

**能否 fork？** 能。CLI `--fork` 配 `--continue`/`--session`。HTTP `POST /session/:id/fork`，body `{ messageID? }`（[Server](https://opencode.ai/docs/server)）。源码：拷贝 `messageID` **之前**的消息（`if (input.messageID && msg.info.id >= input.messageID) break`）（[session/index.ts](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/session/index.ts)）。SDK 客户端：`session.fork({ sessionID, messageID })`（[dialog-fork.tsx](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/components/dialog-fork.tsx)）。当前 SDK 文档页的 Sessions 表未列出 `fork`（[SDK](https://opencode.ai/docs/sdk)），但 server/源码/App 有；CodeMUX 已对托管 runtime 1.18.14 验证 `session.fork`（fork 规格）。

**原生标识？** Session ID（社区与适配器常见 `ses_…` 前缀；以 SDK `Session.id` 为准）。可有 `parentID` 子 session（subagent）。

**历史格式？** `{ info: Message, parts: Part[] }[]`。Message 有 role、id；Part 有 text/tool 等。`GET /session/:id/message`。

**Compact / 摘要？** `POST /session/:id/summarize`；隐藏 compaction/title/summary agents（[Agents](https://opencode.ai/docs/agents)）。`OPENCODE_DISABLE_AUTOCOMPACT` 可关自动压缩（[CLI env](https://opencode.ai/docs/cli/)）。

**权限：** 全局与 per-agent `permission`：`allow` | `ask` | `deny`，键包括 `edit`、`bash`、`skill`、`task` 等；bash 可 glob。Build vs Plan 是同一 runtime 内的 primary agent 切换（Tab），不是换 Codex。切换到 OpenCode 应走 CodeMUX 已有 OpenCode 权限桥，而不是 Claude `permissionMode` 字符串。

**MCP / skills：** `opencode mcp`；agent `permission.skill`；可读取 `.claude` skills（可用 env 关闭）。CodeMUX skills 表已有 `enabled_opencode` 等列（`schema.rs`）。

**对跨 runtime 的含义：** 切到 OpenCode = `session.create` + 若干 `noReply` prompt 写入交接文本 + 用户下一条真实 prompt。`import` 仅当能稳定生成 OpenCode JSON。不要把 Claude session UUID 当成 OpenCode session ID。

### 4.4 三家对照（实施时禁止声称的事）

| 能力 | Claude | Codex | OpenCode |
| --- | --- | --- | --- |
| Resume 本产品 session | 是 | 是 | 是 |
| Fork 本产品 session | 是（SDK+CLI） | 是（app-server；TS SDK 文档无） | 是（HTTP/源码；SDK 文档表可能滞后） |
| 官方导入**外产品**历史 | 否 | Responses items 注入 | noReply；本产品 JSON import |
| 共享对方 session ID | 否 | 否 | 否 |
| Plan/bypass 随 resume | plan/bypass **不**恢复 | sandbox 可在 turn 覆盖 | Plan 是 agent 配置，不是 Claude plan mode |
| 工具协议 | Claude 工具 + MCP | Codex items + MCP | OpenCode tools + MCP |

---

## 5. 针对 CodeMUX 的可行方案

### 5.0 现有实现缝（仓库已核实）

这些不是产品承诺，而是实施时必须踩中的代码事实：

- **Mapping 已支持一会话多 runtime。** `UNIQUE(app_session_id, agent_kind)` 允许同一 `sessions.id` 各有一条 Claude / Codex / OpenCode 原生 ID。`operations.rs` 测试 `deletes_one_agent_session_mapping_for_rewind` 已在同一 `session-1` 上同时插入 Claude 与 Codex mapping。
- **`sessions.agent_kind` 目前只写不改。** 没有 `update_session_agent_kind`。`AgentSelector` 只出现在 `NewSessionPanel`；已有会话的 `getSessionAgentKind` 读 `sessionStore.sessions[].agent_kind`。
- **Sidecar 是进程级单槽。** `ensure_session` 把 `activeAgentKind` 设为目标 flavor；切走 OpenCode 会 `shutdownOpenCodeRuntime()`。同一 sidecar 不能让两个 runtime 同时热写一条对话。这与主方案「串行切换、每次 mint 新原生 session」一致。
- **打开会话的历史加载仍按当前 `agent_kind` 分流到 native loader**（`load_claude/codex/opencode_session_events`）。若切换后仍走这条路径，UI 会丢掉另一家说过的话。切换功能的前置条件是 ADR 0003 已要求的：**UI 以 `session_event_snapshots` 为权威**，native loader 只服务 resume/补洞。
- **同 provider Fork 已打通，且仅当前 runtime。** sidecar `fork_session` 调用 `selectedRuntime().forkSession`；跨 runtime 不能复用这条 API。
- **Anthropic 品牌条款：** Agent SDK overview 不允许第三方产品自称 “Claude Code Agent”。切换器标签应沿用现有 `AGENT_REGISTRY` 文案并对照该页。

### 5.1 主方案：F 指针 + C 重建（同一 CodeMUX 对话）

用户要的是「一条对话里换 Claude Code / Codex / OpenCode 继续干」。市场没有现成的无损热切换；Zed 选择绑死 thread，Warp 选择并行标签。CodeMUX 已经有比它们更强的缝：**canonical Events（ADR 0003）** 和 **每 agent_kind 一条 mapping**。主方案应发挥这两条缝，而不是假装三个 JSONL/thread 能合并。

#### 数据模型

保持：

- `session_event_snapshots`：唯一权威时间线（ADR 0003）。
- `agent_session_mappings(app_session_id, agent_kind, agent_session_id)` 及 `UNIQUE(app_session_id, agent_kind)`。

改变语义，小改 schema：

- `sessions.agent_kind`：**当前活跃 runtime**，不再是「创建时永久绑定」。
- 建议新增（或 JSON 列）：
  - `sessions.active_agent_kind`（若想保留 `agent_kind` 为「出生 runtime」则双字段；否则直接复用 `agent_kind` 并在事件里记出生值）。
  - `session_runtime_switches`：`id, session_id, from_kind, to_kind, at_sequence, handoff_mode (summary|replay_text), new_agent_session_id, created_at`。
- 每次切换后：对目标 `agent_kind` **UPSERT mapping 为新的原生 ID**（默认不保留旧原生 ID）。旧原生 session 视为冻结世界线，不删除对方磁盘（避免误伤用户在 CLI 里 resume 的能力），但 CodeMUX 不再指向它。
- Fork 子会话：继续只复制**当前活跃** runtime 的原生 fork（现有行为）；跨 runtime 的「用 B 继续」走下面 fallback，或在子会话上执行一次切换。

#### 何时允许切换

仅当同时满足：

1. 该 session 无 in-flight turn（已有 `turn_outcome` / 等价结束事件）。
2. 无未应答的 permission / `ask_user_question` / OpenCode question。
3. sidecar 该 session 的当前 runtime 已 idle 或可被 interrupt+shutdown。
4. 目标 runtime 已安装且能 `ensure_session`。

运行中禁止切。不要做「steer 到另一个 harness」——Zed 已说明外部 agent 连 turn 边界都检测不到（[Agent Panel](https://zed.dev/docs/ai/agent-panel)）。

#### 历史如何交接

默认 **summary + 最近回合文本**（对标 Claude「resume from summary」、Zed New From Summary、Agents SDK `input_filter` / nest history、Amp `read_thread`）：

1. 从 `session_event_snapshots` 抽出：用户文本、助手最终文本、被编辑过的路径、当前 todo/plan 摘要、最近一次 turn_outcome。
2. **不要**重放 tool_use/tool_result/权限卡片（跨协议必坏，LangGraph 也警告非法 tool 对）。
3. 目标 runtime：
   - **Claude**：新 `query()`（不要 resume 旧 Claude ID，除非从未离开过 Claude 且 mapping 仍有效——见下）。第一条用户消息（或 SDK 允许的系统附加）放入固定模板：`[CodeMUX runtime switch]` + 摘要 + 「以下为最近对话原文」+ 用户真正的下一句（若切换与发送合并）。
   - **Codex**：`thread/start` → `thread/inject_items` 放入 assistant/user 文本 items → 用户下一 `turn/start`。
   - **OpenCode**：`session.create` → 一条或多条 `prompt({ noReply: true })` → 用户下一 `prompt`。

可选第二档 **replay_text**：最近 N 轮 user/assistant 纯文本按序注入（N 可配，默认 8–20）。仍不重放工具。

**不要**默认 resume mapping 里的旧原生 session：Claude 段之后的 Codex 工作不会出现在旧 Claude JSONL 里。唯一例外：`from_kind == to_kind`（只是误点）或「高级：回到该 runtime 的冻结世界线」（产品上要写清楚会丢掉中间另一 runtime 的对话）。

原生 fork 只用于**同 runtime** 的 CodeMUX Fork 按钮，不用于跨 runtime 切换。

#### Mapping 用法

```
切换 A → B：
  shutdown A runtime
  mint B native session
  inject handoff payload
  UPSERT mapping (app, B) = new_id
  UPDATE sessions.agent_kind = B
  append system_event runtime_switch
  前端不重刷整段历史（Events 仍在）；之后的新事件带 B 的 agent_kind
```

`UNIQUE(app_session_id, agent_kind)` 继续成立。不要试图让三个 native ID 同时「热」着跑同一对话。

#### UI

- 输入框旁现有 agent 选择器：idle 时可点；running 时禁用并说明原因。
- 确认框：目标 runtime、handoff 档位（摘要 / 摘要+近 N 轮）、权限将按目标 runtime 的 preset 重新生效、MCP/skills 将按 `enabled_*` 重载。
- 时间线插入一条不可当 fork 点的系统标记：「已切换到 Codex；以下由 Codex 继续。原生会话已重建，未共用 Claude session ID。」
- 会话列表徽章显示**当前** runtime；可选 tooltip「曾用 Claude Code」。
- 提供次要动作：「在新对话中用 Codex 继续」（fallback D），避免用户不知道历史会重建。

#### 权限 / MCP / skills

切换时走现有 adapter，不要翻译枚举：

- Claude：`buildClaudePermissionOptions`；若用户处于 plan，**重新**以 Claude 方式打开 plan（官方 resume 本来就不恢复 plan）。
- Codex：`buildCodexThreadPermissionOptions`；plan → read-only + on-request。
- OpenCode：现有 permission 桥；Plan 是 OpenCode agent，不是 Claude plan。

MCP：按目标 agent 的适配器重载（CodeMUX 已有分 agent MCP/skills 设计）。Skills 行上的 `enabled_claude` / `enabled_codex` / `enabled_opencode` 在切换后立即生效。不要声称「Claude 已批准的 bash 在 Codex 里仍然批准」。

#### 禁止对外声称

- 不能共用原生 session ID。
- 不能无损重放工具调用。
- 不能把三条磁盘 transcript 合成一条 provider 历史。
- 不能保证 prompt cache 在切换后命中。
- 不能保证 plan/bypass/sandbox 语义连续。

#### 分阶段

| 阶段 | 内容 | 退出标准 |
| --- | --- | --- |
| **P0** | Idle 切换；摘要注入；mapping UPSERT；`system_event`；权限/MCP/skills 重载；运行中禁用 | 三方向（C↔X、C↔O、X↔O）各手动跑通一轮 |
| **P1** | 近 N 轮纯文本 replay；切换确认里可选 | fixture：Events → 各 runtime 注入 payload |
| **P2** | UI 次要入口「新对话中用 X 继续」（现有 fork + 目标 kind） | 与现行 fork 测试共存 |
| **P3（可选）** | 「回到该 runtime 冻结世界线」resume 旧 mapping | 必须有明确文案；默认关闭 |
| **P4（可选，Pattern E）** | 不换驾驶席：当前 agent 通过 MCP 调用另外两家（对齐 [Codex `mcp-server`](https://learn.chatgpt.com/docs/mcp-server) 的 `codex` / `codex-reply`） | 适合「Claude 规划、Codex 落地」；不是「我要亲手开 Codex」 |
| **不做** | 运行中切换；工具重放；改 JSONL 冒充 Claude 历史；Orchestrator 自动把用户对话交给另一 harness | — |

### 5.2 Fallback：Pattern D「切换即开子会话」

若 P0 的同一对话重建让用户困惑（「上面还是 Claude 的工具卡片，下面突然 Codex」），或注入 API 在某 runtime 版本不可用：

- 复用 `create_forked_session` 管线，但目标 `agent_kind` 为新 runtime。
- 子 CodeMUX session 拷贝 Events 到所选 assistant 消息；对新 runtime mint session + 摘要注入（Claude 路径不要用「截断 JSONL + Claude fork」去喂 Codex）。
- 父会话仍永久绑定原 runtime（符合 2026-06-10 非目标）。
- UI：Fork 菜单增加「Fork to Codex / OpenCode / Claude Code」。

这比主方案更安全、更接近 Zed「新 thread 选 agent」，但不是「同一条对话」。可作为 P0 的逃生门与 P2 的正式入口。

### 5.3 不推荐作为主路径的方案

- **纯 E（编排器）**：用户目标是自己选 Claude/Codex/OpenCode，不是 Orchestrator 派工。E 可后来做「用 OpenCode explore 只读」之类。
- **纯 G**：只靠 git 交接会丢掉计划和对话决策。
- **Resume 旧 mapping（无重建）**：中间另一 runtime 的工作从模型上下文消失，但 UI 仍显示那些消息 → 严重不一致。

---

## 6. 风险与开放问题

1. **Claude 无官方 import**：摘要进 prompt 是唯一稳妥路径。用内部 JSONL 拼外来消息会跟官方警告对着干。
2. **Codex `inject_items` vs TS SDK**：官方写在 app-server；CodeMUX 若只用 `@openai/codex-sdk` 的 `run()`，可能没有注入面。需确认 sidecar 是否已连 app-server（fork 规格表明已为 fork 开过 app-server）。
3. **OpenCode `import` JSON 形状**：CLI 能 import，但跨版本 schema 需对托管 runtime 做测试；P0 应用 `noReply` 文本，不要赌 import。
4. **OpenCode fork 边界**：`messageID` 是 exclusive before；与切换无关，但若 fallback fork 到 OpenCode 仍要沿用现有「下一条 message」修正。
5. **Codex fork 的 `sessionId` vs `id`**：文档示例里 fork 后 `sessionId` 可能仍是 root。Mapping 必须存 **thread.id**（新 id），不要存错字段。
6. **工作区互踩**：三 runtime 写同一 cwd。Zed 用 worktree 隔离并行线程。CodeMUX 初版 fork 规格明确不建 git 分支。切换是串行还好；若用户快速来回切，未提交 diff 会让下一 runtime「看见」上一 runtime 的文件，但「看不见」其工具解释——摘要里应列出 touched files。
7. **权限语义裂缝**：Claude 不恢复 plan/bypass；Codex plan 是 sandbox；OpenCode Plan 是 agent。切换确认必须重选或重申 preset。
8. **MCP 双源**：Zed 已遇到「Zed MCP + agent 自己的 MCP」。CodeMUX 也是「应用 MCP 适配 + 原生配置」。切换后工具列表变化，模型可能仍根据摘要以为有旧工具。
9. **费用与 cache**：切换等于冷启动。Claude 官方写明 cache 过期后全量历史会再计费。应对用户提示「此次切换会按新会话计费」。
10. **UI 认知**：同一气泡时间线混三种工具卡片。必须有 switch marker；考虑按 runtime 着色。
11. **产品规则冲突**：2026-06-10 规格把「不可切换」写成非目标。实施需正式修订该规格，而不是静默改行为。
12. **ACP 长期**：Zed 押 ACP。若三家都稳定 ACP，未来可用「ACP session 导入」代替自建注入。当前 CodeMUX 已直连三家 SDK，不必为切换先迁 ACP。
13. **历史双源**：若切换后 `load_session_events` 仍只读目标 runtime 的磁盘 transcript，UI 会丢另一 runtime 的气泡。必须先让 snapshots 成为打开会话的权威来源。
14. **未核实**：Cursor 官方 docs 站点对本调研的若干深层 URL 返回通用门户页（SPA），fork/锁模型细节来自论坛员工回复，不是 docs.cursor.com 正文。OpenHands GUI 换 agent 能力因页面超时未核实。PearAI/Void/Dify 未做 runtime 级核验。OpenCode SDK 文档 Sessions 表与 server `fork` 不一致，以 server/源码/CodeMUX 已验证行为为准。

---

## 来源

### Claude Code / Anthropic

- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Work with sessions (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/sessions)
- [CLI reference（`--fork-session` / `--resume`）](https://code.claude.com/docs/en/cli-reference)
- [Permission modes](https://code.claude.com/docs/en/permission-modes)
- [Commands（`/resume` `/branch` `/fork`）](https://code.claude.com/docs/en/commands)

### OpenAI Codex

- [Codex SDK](https://developers.openai.com/codex/codex-sdk)
- [Codex App Server](https://developers.openai.com/codex/app-server)（含 `thread/resume`、`thread/fork`、`thread/inject_items`、`thread/compact/start`）
- [Developer commands](https://developers.openai.com/codex/developer-commands)
- [openai/codex#29859](https://github.com/openai/codex/issues/29859)（TS SDK 缺 fork 的 issue 描述）
- [openai/codex app-server 源码树](https://github.com/openai/codex/tree/main/codex-rs/app-server)

### OpenCode

- [CLI](https://opencode.ai/docs/cli/)（`--session` `--fork` `import`/`export`）
- [SDK](https://opencode.ai/docs/sdk)（`session.prompt`、`noReply`）
- [Server](https://opencode.ai/docs/server)（`POST /session/:id/fork`、message `noReply`）
- [Agents](https://opencode.ai/docs/agents)（primary Build/Plan vs subagent）
- [session.fork 源码](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/session/index.ts)
- [HTTP session.fork](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/server/routes/session.ts)
- [App fork 调用 `session.fork`](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/components/dialog-fork.tsx)

### 编码产品

- [Cursor Docs](https://docs.cursor.com/agent/overview)
- [Cursor Forum: Fork Chat](https://forum.cursor.com/t/question-about-fork-chat/165793)
- [Cursor Forum: model switch lock](https://forum.cursor.com/t/switching-models-is-unavailable-in-this-conversation-start-a-new-conversation-to-use-a-different-model/157132)
- [Continue Agent mode](https://docs.continue.dev/ide-extensions/agent/how-it-works)
- [Continue TUI `/resume` `/fork` `/model`](https://docs.continue.dev/cli/tui-mode)
- [Cline Agent API `restore`](https://docs.cline.bot/sdk/reference/agent)
- [ClineCore vs Agent](https://docs.cline.bot/sdk/clinecore)
- [Cline ACP](https://docs.cline.bot/usage/acp)
- [OpenHands configuration](https://docs.all-hands.dev/usage/configuration-options)
- [Aider usage `/model`](https://aider.chat/docs/usage.html)
- [Goose CLI commands](https://github.com/block/goose/blob/58f3cc9e/documentation/docs/guides/goose-cli-commands.md)
- [Goose session management](https://github.com/block/goose/blob/58f3cc9e/documentation/docs/guides/sessions/session-management.md)
- [Amp SDK thread continuity](https://ampcode.com/manual/sdk)
- [Amp context / `read_thread`](https://ampcode.com/guides/context-management)
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel)
- [Zed External Agents](https://zed.dev/docs/ai/external-agents)
- [Zed ACP Registry 博文](https://zed.dev/blog/acp-registry)
- [Warp third-party CLI agents](https://docs.warp.dev/agent-platform/cli-agents/overview/)
- [Warp CLI `--resume` `/handoff`](https://docs.warp.dev/cli/reference/)
- [Copilot CLI resume](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
- [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Copilot App slash `/fork`](https://docs.github.com/en/copilot/reference/github-copilot-app-reference/slash-commands)
- [Copilot SDK session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence)

### 编排框架

- [LangChain/LangGraph Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)
- [create_handoff_tool](https://reference.langchain.com/python/langgraph-supervisor/handoff/create_handoff_tool)
- [OpenAI Agents SDK orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [Magentic-One](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)
- [CrewAI Processes](https://docs.crewai.com/en/concepts/processes)
- [Google ADK multi-agent workflows](https://google.github.io/adk-docs/agents/multi-agents/)

### CodeMUX 内部（产品约束，非市场事实）

- `docs/superpowers/specs/2026-06-10-multi-agent-codex-integration-design.md`（绑定 `agent_kind`；非目标：session 内切换）
- `docs/adr/0003-codemux-event-protocol.md`（canonical Events）
- `docs/superpowers/specs/2026-08-08-conversation-fork-feature.md`（三家原生 fork）
- `docs/superpowers/specs/2026-06-29-agent-permission-approval-alignment-design.md`
- `docs/superpowers/specs/2026-07-12-opencode-sdk-agent-design.md`
- `src-tauri/src/db/schema.rs`（`sessions.agent_kind`；`agent_session_mappings` UNIQUE）
- `src-tauri/src/db/operations.rs`（同 session 多 mapping 测试；无 `update_session_agent_kind`）
- `src-tauri/sidecar/src/index.ts`（`ensure_session` 单槽；切走 OpenCode 即 shutdown；`fork_session` 仅当前 runtime）
- `src-tauri/src/agent/history_import.rs`（`load_session_events` 按 `agent_kind` 分流 native loader）
- `src/components/agent/NewSessionPanel.tsx`（`AgentSelector` 仅新会话）
- `src/stores/agentStore.ts`（`getSessionAgentKind`）
- [Claude Agent SDK branding](https://code.claude.com/docs/en/agent-sdk/overview)
- [Codex as MCP server](https://learn.chatgpt.com/docs/mcp-server)
