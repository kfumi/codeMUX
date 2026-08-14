
# codeMUX Domain Context

## Glossary

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
不属于用户或助手正文、但会改变对话解释方式的领域事件，例如上下文压缩边界。它可以被 UI 投影为状态提示，但不应被当作助手正文。
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
应用级当前默认选用的 Model Provider，用作新建会话的默认。切换智能体种类时不自动更换。会话可另行选定供应商与模型并持久化，发送时以会话选定为准。
_Avoid_: active profile（按智能体分别激活的供应商配置档）

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
会话级思考强度的规范值：关闭、低、中、高、极高、最高。发送时由各协议映射为自身参数，而不是 UI 选项的逐字透传。
_Avoid_: thinking mode, reasoning_effort（当指 UI 档位时）

## Preferred Terms


| Use | Avoid |
|-----|-------|
| Model Provider / 供应商 | Agent Provider Profile（指供应商配置时） |
| Protocol Endpoint / 协议端点 | 把双协议拆成两个供应商 |
| Active Provider | 按智能体分别激活的 profile |
| Built-in Provider Template / 内置供应商模板 | 与自定义供应商分叉的第二套模型 |
| Provider Credentials（显式配置） | 空 key 魔法回落 CLI |
| Provider Enabled / 启用 | 用删除代替停用 |
| Enrichment Provider / enrichment 供应商 | vision model, fallback model |
| Attachment Processor / 附件处理器 | enricher, handler |
| Enriched Context Block / enriched 上下文块 | OCR 结果, caption |
| Reasoning Effort / 思考强度 | thinking mode（当指会话档位时） |

## Notes

- 从 AgentProviderProfile 升级到 Model Provider 时不做自动迁移；旧 registry 丢弃，用户按内置模板重新配置。

## Out of Scope (for this feature's first cut)

