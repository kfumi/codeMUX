
# codeMUX Domain Context

## Glossary

### Session
CodeMUX 应用层的一条对话。它拥有稳定的会话身份和一条连续的 CodeMUX Event 时间线；切换智能体种类不创建新 Session，也不把已有气泡搬走。
_Avoid_: thread（当指应用对话时）, conversation（与 Session 混用）, 混合模式对话

### Agent Kind
独立的编码智能体运行时种类：Claude Code、Codex 或 OpenCode。每种有自己的工具协议、权限模型和原生 session 存储；它不是 Model Provider，也不是同一运行时内的 Plan/Build 模式。
_Avoid_: 智能体（单独使用且未区分种类与模型时）, runtime（与 sidecar 进程混淆时）, agent, harness, 混合模式, gemini_cli（当前未接入，不是本上下文的 Agent Kind）

### Active Agent Kind
当前 Session 上正在驾驶的 Agent Kind。它是指针，不是出生绑定；同一 Session 在生命周期内可以先后由不同 Agent Kind 驾驶。
_Avoid_: 把 `agent_kind` 理解成创建后永久绑定；用 Model Provider 或 Plan/Build 表达驾驶席切换

### Native Session
某一 Agent Kind 自己持久化的对话身份，例如 Claude 的 session UUID、Codex 的 thread id、OpenCode 的 session id。它不是 Session。不同 Agent Kind 的 Native Session 永远不是同一条身份。一次 Agent Kind Switch 会为进入的种类新建 Native Session；该种类此前的 Native Session 不再是本 Session 的继续目标。
_Avoid_: 把原生 ID 当 Session ID；跨种类共用或合并 Native Session；切回时 resume 旧 Native Session

### Agent Kind Switch
在已有 Session 上把 Active Agent Kind 换成另一种，不创建新 Session，也不移交 Native Session。只在 Claude Code、Codex、OpenCode 之间成立。用户确认后立即成立，不绑在下一条 User Message 上。用户可见时间线仍是原 Session 的 CodeMUX Event 序列。仅当最近一轮已有 Turn Outcome、且没有未应答的 Interactive Request 时才成立；进行中的一轮不能切换。只读或导入快照 Session 不能切换。若存在尚未发送的排队 User Message，切换仍可成立，但队列保持暂停，不会自动发给进入的 Agent Kind。
_Avoid_: fork（当指同一 Session 换驾驶席时）, handoff（当指编排框架把对话交给另一进程内 agent 时）, resume（当指跨种类继续时）, 轮中热切 / steer, 把切换推迟到下次发送, 把未接入的种类纳入切换, 切换后自动放行队列

### Fork
从某条已完成的助手消息切开，创建一条新的 Session，并拷贝到该点为止的历史。子 Session 的 Active Agent Kind 与父 Session 当时相同，并做该种类的原生 fork。Fork 不是 Agent Kind Switch；首版不提供「Fork 到另一种类」。
_Avoid_: 用 Fork 换驾驶席；把 Switch 做成新 Session

### Switch Briefing
从 Session 的 CodeMUX Event 做确定性投影得到的文本摘要（最近用户文本、助手最终文本、工具触及的路径、最后一次 Turn Outcome），在 Agent Kind Switch 当时注入目标 Agent Kind **新创建**的 Native Session。它不另调用模型，也不先让当前种类 compact。它不是 User Message，也不在时间线里冒充用户说过的话。切回曾经用过的种类时同样如此。它不是工具调用重放，也不是对该种类旧 Native Session 的 resume。
_Avoid_: 完整历史导入, tool replay, 把权限审批当可迁移状态, 把 Briefing 当下一条用户消息的前缀, 用另一次模型调用或 native compact 生成 Briefing

### Permission Snapshot
当前对 Active Agent Kind 生效的权限预设（Claude 的 permission mode、Codex 的 sandbox/approval、OpenCode 的 permission）。它从属于 Active Agent Kind，不是 Session 上可随身携带的意图。Agent Kind Switch 丢弃旧快照（含 plan 与原生「本会话已允许」），并换上进入种类的默认预设。
_Avoid_: 跨种类翻译权限枚举；把 plan_mode 当切换后仍成立的会话意图

### Message UUID
Agent 原生消息 UUID，用于标识一轮具体对话消息。前端 assistant message 的 `uuid` 作为跨层日志中的 message ID。

### Log Context
跨层日志上下文，包含应用 session ID 和可选的 message UUID。Rust 核心路径使用 task-local 上下文，Sidecar 使用轻量运行时上下文；日志以 `[session=...][msg=...]` 前缀输出。

### CodeMUX Event
跨智能体运行时传递的一条规范化对话事件，描述用户消息、助手消息、文本或推理增量、工具生命周期、系统状态、诊断、错误、用量或一轮结束结果。它不包含具体 provider 的事件语义。
_Avoid_: provider event, stream event

### User Message
用户提交给智能体、并且应当在对话历史中恢复的可见消息。它与智能体内部注入的环境上下文、压缩摘要和工具结果不同。
_Avoid_: prompt, input event

### System Event
不属于用户或助手正文、但会改变对话解释方式的领域事件，例如上下文压缩边界和 Agent Kind Switch。它可以被 UI 投影为状态提示，但不应被当作助手正文或 User Message。
_Avoid_: provider system message

### Diagnostic Event
描述事件流异常、缺口或无法识别输入的 CodeMUX Event。它用于诊断和审计，不改变一轮的 Turn Outcome。
_Avoid_: runtime error

### Application Control Event
驱动应用生命周期或控制面的事件，例如 Sidecar 就绪、MCP 状态、代理端口、Todo、文件快照和重连状态。它不是对话领域事件，不进入历史 CodeMUX Event 序列。
_Avoid_: conversation event

### Turn Outcome
一轮对话最终的完成状态，表示已完成、失败、中断或取消；其中由空闲守卫触发的超时是一种可恢复的完成状态（中止当前轮、保留会话供重试），而非失败。它与描述中途原因的错误事件分开。
_Avoid_: result status, error status

### Interactive Request
暂停当前 turn、等待人类决策的请求，包括权限审批与问题作答。挂起期间 turn 处于"等待人类"而非"引擎停滞"，因此空闲守卫不得触发。
_Avoid_: permission prompt, approval dialog, user input tool

### Engine Stall
当前轮既无进展事件、也无未决交互请求的状态；该状态持续超过空闲窗口即由空闲守卫判定并触发可恢复超时。它与引擎正常完成（如 session.idle）不同。
_Avoid_: idle, timeout

### Event Sequence
同一会话内 CodeMUX Event 的有序位置。它用于保证增量事件顺序、识别事件缺口，并使结束事件具备幂等语义。
_Avoid_: event index, provider sequence

### Model Provider
CodeMUX 自有的模型服务供应商配置单元：标识一家厂商或中转，并持有共享凭据与一份模型目录（含默认模型）。它与具体智能体种类无关；生命周期内不读写智能体原生配置文件，对话凭据仅经运行时注入 SDK。一家供应商可挂多个协议端点；端点可可选覆盖凭据。
_Avoid_: Agent Provider Profile, provider profile, 智能体配置档（当指供应商时）

### Protocol Endpoint
某一 Model Provider 下的一条协议访问入口。第一版协议类型仅为 `anthropic` 与 `openai_compatible`，并包含 base URL 与该入口所需的连接附属项（例如 Codex 是否需要兼容代理）。对话时按当前智能体所需协议从供应商中选取匹配端点。
_Avoid_: base URL（单独当作供应商）, Anthropic/OpenAI URL（当作互斥的两个供应商）；按智能体命名协议

### Active Provider
应用级当前默认选用的 Model Provider，用作新建会话的默认。新建草稿里改 Agent Kind 时不自动更换。发送时以当前 Session 上 Active Agent Kind 对应的 Kind Model Selection 为准。
_Avoid_: active profile（按智能体分别激活的供应商配置档）

### Kind Model Selection
某一 Session 为某个 Agent Kind 记住的 Model Provider、模型与 Reasoning Effort。Agent Kind Switch 恢复进入种类的这一组，而不是留下一种类的供应商或思考档位。若该种类尚无记录，则回落到能提供匹配 Protocol Endpoint 的 Active Provider 及其默认档位；再没有则切换不能成立。恢复后仍按该模型可支持的档位规范化。
_Avoid_: 一份会话级 provider/model/effort 跨种类沿用；切换时强行重置为 Active Provider

### Built-in Provider Template
由应用预置的 Model Provider 模板：预填厂商名称、协议端点 URL 与常用模型，用户补齐凭据后即可使用。它不是独立配置实体，实例化后仍是普通 Model Provider。OpenCode Go 属于此类模板，与智能体种类 OpenCode 不同。
_Avoid_: 把内置目录做成与自定义供应商不同的第二套配置模型；用 OpenCode 兼指 Go 订阅供应商与智能体

### Provider Credentials
Model Provider 用于调用模型服务的密钥与端点信息。缺少可用凭据（如 API Key 为空）即视为未配置，不能靠空值隐式回落智能体 CLI 登录或原生配置文件。
_Avoid_: 空 API Key 表示使用 CLI 认证

### Provider Enabled
Model Provider 是否对会话可选。禁用后配置保留，但不可被选为可用供应商；已绑定该供应商的会话在改选前不可发送。
_Avoid_: 用删除表达临时停用；禁用后仍允许已绑会话继续调用

### Attachment
用户随 User Message 一并提交的、非文本的附加内容。首版仅包含 image；UI 中始终保留原始 Attachment 供用户查看，与发给智能体的 payload 可以不同。
_Avoid_: 截图（当泛指一切图片时）, file upload

### Vision Capability
当前会话所选模型能否原生接收 image modality 的能力。与 Agent 种类无关，由 Model Provider 目录中的模型元数据、运行时探测结果共同决定。
_Avoid_: multimodal support, 多模态

### Attachment Enrichment
在 User Message 发送给智能体之前，将 Attachment 转为结构化文本上下文的过程。Enrichment 结果合并进 User Message 文本，供不支持 Vision Capability 的模型使用。
_Avoid_: OCR, 截图理解, image caption

### Enrichment Provider
专门执行 Attachment Enrichment 的 Model Provider 及其模型配置（如 GLM-4.6V-Flash）。与会话当前选用的 Model Provider 独立，由应用级设置指定。
_Avoid_: vision model, fallback model

### Enriched Context Block
Attachment Enrichment 产出、合并进 User Message 文本的描述块。每个 Attachment 对应一个 Block，由 Enrichment 模型自由生成的 Markdown 包裹在固定边界标记内；UI 中不作为 User Message 正文展示，仅注入发给智能体的 payload。
_Avoid_: OCR 结果, caption, system prompt

### Attachment Processor
按 Attachment 类型执行 Enrichment 的处理单元。每种类型（如 image、pdf）对应一个 Processor，由 Sidecar 内的 Registry 按类型分发。首版仅实现 image Processor。
_Avoid_: enricher, handler, adapter（当指 Enrichment 处理时）

### Reasoning Effort
当前 Active Agent Kind 的思考强度规范值：关闭、低、中、高、极高、最高。各 Agent Kind 在 Kind Model Selection 中分别记住自己的档位；发送时由该种类的协议映射为自身参数，而不是 UI 选项的逐字透传，也不是一条 Session 上跨种类共用的档位。
_Avoid_: thinking mode, reasoning_effort（当指 UI 档位时）；把思考强度当切换后仍沿用的会话级属性

### Mobile Companion
浏览器中的移动端 PWA，与桌面实例配对后查看并驱动其 Session。它是桌面的远程伴侣而不是独立应用：算力、配置与权威存储都在桌面端。它只看到未归档的 Session，可在已有项目上新建 Session，发消息进入同一队列，审批走同一条响应命令。
_Avoid_: 移动端独立应用, 云同步端, 手机版桌面

### Companion Server
桌面端开启移动同步后对外暴露的本机 HTTP/WS 服务（内嵌于 Rust）。它提供配对、会话列表与事件历史的只读查询、实时 CodeMUX Event 订阅，以及驱动动作（发送/新建/审批）的转发。它是移动端对桌面的唯一寻址入口；未来公网中继只换寻址路径，不换协议。
_Avoid_: 中继服务, 云服务, sync server（当指跨设备状态数据库时）

### Pairing Token
一次设备配对后颁发给某台移动设备的长期随机凭证，移动端存于 IndexedDB，所有请求与 WS 连接携带它以鉴权。它是「这台手机配过这台桌面」的信任凭证；桌面端可撤销，撤销后该设备失效。
_Avoid_: 会话 token, session credential, API key

### Device Pairing
移动端与桌面实例建立信任的动作：扫码读取桌面地址与一次性配对码，换取该设备的 Pairing Token。配对建立后移动端即信任该桌面。
_Avoid_: 登录, 连接（当指长期信任时）

## Preferred Terms


| Use | Avoid |
|-----|-------|
| Session / 会话 | 混合模式对话, thread（指应用对话时） |
| Agent Kind / 智能体种类 | 用「智能体」兼指种类、模型与 Plan/Build |
| Active Agent Kind / 当前智能体种类 | 创建后永久绑定的 agent_kind |
| Native Session / 原生会话 | 把原生 ID 当成 Session |
| Agent Kind Switch / 智能体种类切换 | 用 fork/handoff/resume 称呼跨种类继续 |
| Fork | 用 Fork 换驾驶席；把 Switch 做成新 Session |
| Switch Briefing / 切换摘要 | 完整历史导入, tool replay |
| Permission Snapshot / 权限快照 | 跨种类翻译权限枚举；切换后仍有效的 plan |
| Model Provider / 供应商 | Agent Provider Profile（指供应商配置时） |
| Protocol Endpoint / 协议端点 | 把双协议拆成两个供应商 |
| Active Provider | 按智能体分别激活的 profile；Agent Kind Switch 时沿用上一种类的供应商 |
| Kind Model Selection / 种类模型选择 | 一份会话级 provider/model/effort 跨种类沿用 |
| Reasoning Effort / 思考强度 | thinking mode（当指会话档位时）；切换后沿用上一种类的档位 |
| Built-in Provider Template / 内置供应商模板 | 与自定义供应商分叉的第二套模型 |
| Provider Credentials（显式配置） | 空 key 魔法回落 CLI |
| Provider Enabled / 启用 | 用删除代替停用 |
| Enrichment Provider / enrichment 供应商 | vision model, fallback model |
| Attachment Processor / 附件处理器 | enricher, handler |
| Enriched Context Block / enriched 上下文块 | OCR 结果, caption |
| Mobile Companion / 移动伴侣 | 独立移动应用, 云同步端 |
| Companion Server / 伴侣服务 | 中继服务, 云服务 |
| Pairing Token / 配对令牌 | 会话 token, API key |
| Device Pairing / 设备配对 | 登录, 普通连接 |

## Notes

- 从 AgentProviderProfile 升级到 Model Provider 时不做自动迁移；旧 registry 丢弃，用户按内置模板重新配置。
- Agent Kind Switch 的决策见 [ADR 0007](docs/adr/0007-agent-kind-switch-in-session.md)。
- 移动端决策见 [ADR 0008](docs/adr/0008-mobile-companion.md)。

## Out of Scope (for this feature's first cut)

- `gemini_cli`：当前未接入，不参与 Agent Kind Switch。
- 移动端（Mobile Companion）首版不含：公网中继、系统推送通知、图片/文件附件、多桌面配对、富渲染（终端/xterm、diff 全展开、语法高亮）。

