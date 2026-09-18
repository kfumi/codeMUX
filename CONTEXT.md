
# codeMUX Domain Context

## Glossary

### Session
CodeMUX 应用层的一条对话。它拥有稳定的会话身份和一条连续的 CodeMUX Event 时间线；切换智能体种类不创建新 Session，也不把已有气泡搬走。
_Avoid_: thread（当指应用对话时）, conversation（与 Session 混用）, 混合模式对话

### Agent Kind
独立的编码智能体运行时种类：Claude Code、Codex、OpenCode 或 pi（pi 为后接入的极简多供应商运行时，定义见 `src/types/agentRegistry.ts`）。每种有自己的工具协议、权限模型和原生 session 存储；它不是 Model Provider，也不是同一运行时内的 Plan/Build 模式。
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
当前对 Active Agent Kind 生效的权限预设（Claude 的 permission mode、Codex 的 Workflow Mode、OpenCode 的 permission）。它从属于 Active Agent Kind，不是 Session 上可随身携带的意图。Agent Kind Switch 丢弃旧快照（含 Plan Mode 与原生「本会话已允许」），并换上进入种类的默认预设。
_Avoid_: 跨种类翻译权限枚举；把 Plan Mode 当切换后仍成立的会话意图

### Workflow Mode
Codex 的 sandbox 与 approval 工作流预设，取值为 read-only、auto、auto-review、full-access 四档之一。它是 Permission Snapshot 的一部分，与 Plan Mode 正交。
_Avoid_: permission mode（当指 Claude 时）, 计划模式（当指 Plan Mode 时）, sandbox mode（单独当作 UI 选项时）

### Plan Mode
Codex 的协作模式开关：开启时 agent 以 plan collaboration 运行，产出计划后经 Plan Approval 等待用户 Implement 或 Dismiss；Implement 后自动进入 implementation turn 并关闭 Plan Mode。它与 Workflow Mode 正交，同属 Permission Snapshot，但不是 sandbox preset 的别名。
_Avoid_: 计划模式（与 Workflow Mode 混用）, plan preset, 把 Plan Mode 等同于 read-only Workflow Mode

### Plan Approval
Plan Mode 下 turn 正常完成后挂起的 Interactive Request，等待用户 Implement（执行计划）或 Dismiss（放弃）。它不是 app-server 反向 RPC，而是应用层在 turn 完成后合成的审批请求。
_Avoid_: plan permission, 计划确认对话框（未说明是 Interactive Request 时）

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

### Queued Message
一轮进行中提交的 User Message，在当前 Turn 结束后才作为下一轮发送。队列按提交顺序执行，可重排、编辑与删除；中断或失败后队列保持暂停，需手动放行。
_Avoid_: steering（注入进行中的一轮）, 把排队消息当作已进入对话历史的消息

### Immediate Run
把某条 Queued Message 立刻生效的动作。用户可在设置中选择默认走注入当前轮（steer）还是打断当前轮；缺省为注入。当前 Agent Kind 支持注入且偏好为注入时，将消息 steer 进进行中的 turn（不打断、不改 Turn Outcome）；偏好为打断、不支持、没有活跃 turn、斜杠命令、或协议拒绝时，回落为打断当前轮再作为下一轮发送。其余排队消息保留原顺序，等这一轮真正结束后再发。
_Avoid_: 把普通 composer 发送当成 steer, 清空剩余队列, 中断后自动放行整个队列

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

### Daemon
本机权威：拥有 SQLite Timeline、Session、Agent Kind 编排、Sidecar、MCP、skills 与 Scheduled Task。窗口不是 Daemon；Sidecar 也不是。
_Avoid_: 后端（含糊）, sidecar（当指权威时）, Electron main, Tauri command 层

### Desktop Shell
承载窗口、托盘、自动更新、原生对话框与 Browser Host 的桌面宿主。它不拥有 Session，也不驾驶 Agent Kind。
_Avoid_: 桌面应用（当兼指 Daemon 与 UI 时）, 前端

### Daemon Client
通过 Companion Server 与 Daemon 对话的客户端。桌面 UI、Mobile Companion 与 CLI 都是 Daemon Client。
_Avoid_: 把 Tauri invoke 当业务 API；把壳 IPC 当 Daemon 协议

### Companion Server
Daemon 的 HTTP/WS 协议入口（内嵌于 Rust）。回环始终供本机 Daemon Client 使用；局域网与中继暴露仍由用户显式开启。它提供配对、Session 与 Timeline 查询、CodeMUX Event 订阅，以及驱动动作的转发。公网中继只换寻址路径，不换协议。
_Avoid_: 中继服务, 云服务, sync server（当指跨设备状态数据库时）；把服务是否存在等同于是否开启移动伴侣

### Local Daemon Token
Daemon 颁发给本机 Desktop Shell 或 CLI 的回环鉴权凭证。它不是 Pairing Token，不代表一台已配对手机。
_Avoid_: Pairing Token（当指本机桌面连接时）, API key, 会话 token

### Pairing Token
一次设备配对后颁发给某台移动设备的长期随机凭证，移动端存于 IndexedDB，所有请求与 WS 连接携带它以鉴权。它是「这台手机配过这台桌面」的信任凭证；桌面端可撤销，撤销后该设备失效。
_Avoid_: 会话 token, session credential, API key；用 Pairing Token 冒充本机桌面连接

### Device Pairing
移动端与桌面实例建立信任的动作：扫码读取桌面地址与一次性配对码，换取该设备的 Pairing Token。配对建立后移动端即信任该桌面。
_Avoid_: 登录, 连接（当指长期信任时）；把 Desktop Shell 连回环当成 Device Pairing

### Browser Host
Desktop Shell 上的内置浏览契约：创建、导航、停放浏览器页，并与主界面隔离站点资料。Daemon 不创建 WebView；智能体网页工具若存在，只转发给声明了该能力的壳。
_Avoid_: iframe, 系统浏览器（当指内置页时）；把浏览页当成 Session

### Scheduled Task
一条持久的定时任务定义：绑定项目、Agent Kind、Kind Model Selection、用户为该任务选定的 Permission Snapshot、计划与任务指令。它不是 Session，也不另建一套对话时间线。
_Avoid_: automation, job, workflow, cron job（当指用户可见实体时）；把权限理解成只能跟全局设置走、创建时不能改档

### Task Instruction
定时任务到点发出的 User Message 模板。它是用户可见消息，不是 system prompt，也不是 Switch Briefing。
_Avoid_: prompt, system prompt, 自动化脚本

### Schedule
绑定在一条 Scheduled Task 上的一条重复规则（每小时、每天、每工作日、每周、每月，加本机时刻）。用户侧不把 cron 当作名称。
_Avoid_: cron（用户可见名称）, timer, heartbeat

### Task Run
一次计划触发所产生的执行记录：创建或续上一条 Session，并把任务指令作为 User Message 发出。对话内容仍是该 Session 的 CodeMUX Event 序列。
_Avoid_: job execution, instance；与 Immediate Run（排队消息插队）混称

### Run Delivery
一次 Task Run 如何落到 Session：新建一条 Session，或续写该任务上次 Run 的 Session。首版仅新建。
_Avoid_: 用 Codex 的「现有聊天 / 新聊天」当领域词；把 Delivery 当成通知渠道

### Command
一个可被触发的应用内动作，拥有稳定 id、标题、分组与执行体。它是快捷键的被绑定物，而不是键位；键位是绑在它上面的 Shortcut。
_Avoid_: 用「快捷键」代指命令本身；把 Command 做成随组件创建的匿名回调；用本地化标题当 id

### Shortcut
一条 Command 与一个 Keybinding 的绑定关系。它可以被用户重绑、显式解绑或恢复默认；出厂默认只在读取时合并，从不落盘。
_Avoid_: 把 Shortcut 与 Keybinding 混用；把「快捷键」当成键位字符串本身

### Keybinding
一串物理按键组合（如 `Mod+Shift+P`）。它是 Shortcut 的键位部分，不含平台含义，也不含执行体。
_Avoid_: 把 Cmd/Ctrl 写进存储值；把「快捷键一览表」当成配置

### Mod
平台主修饰键的规范写法：macOS 为 Cmd，其余平台为 Ctrl。存储与匹配一律使用 Mod，展示时才渲染成 ⌘ 或 Ctrl。
_Avoid_: 在配置或匹配逻辑中硬编码 Cmd 或 Ctrl；把 Alt/Option 混写进 Mod

### Shortcut Execution
一次按键序列命中某条 Shortcut 并执行其 Command 的过程。命中要求规范化后的 Keybinding 与该次按键相等；一次按键最多执行一条 Shortcut，目录中先命中者胜。
_Avoid_: 把按键透传给组件后仍执行全局命令；同一次按键触发多条 Shortcut

### Shortcut Catalog
应用内置的全部 Shortcut 定义：稳定 id、分组、标题与出厂默认键位。它是「哪些命令可被绑定」的唯一真值源；用户可以改键位，不能改目录。
_Avoid_: 把目录当成用户设置的一部分；在目录里塞用户自定义命令

### Shortcut Override
用户对某条 Shortcut 偏离出厂默认的那一份稀疏记录。只有覆盖存在时才算自定义；取值等于出厂默认的覆盖不携带用户意图，应被丢弃。
_Avoid_: 把整份键位表物化落盘；把「等于默认」当成一次真实修改

### Unbound
用户把某条 Shortcut 的 Keybinding 置为「无」的显式状态。它与「没有覆盖、用默认」是两件不同的事，必须能跨版本存活，且不会与任何键位冲突。
_Avoid_: 用删除覆盖表达解绑；把解绑值当成非法值而回落到默认

### Reserved Keybinding
属于宿主平台或文本编辑语义、不允许被任何 Shortcut 占用的键位（复制、粘贴、全选、撤销、重做、刷新、回车发送、关闭窗口等）。它在录制时就被拒绝，而不是先占用再让路。
_Avoid_: 让出厂默认绕开保留表；把保留表当成平台 API 查询

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
| Permission Snapshot / 权限快照 | 跨种类翻译权限枚举；切换后仍有效的 Plan Mode |
| Workflow Mode / 工作流模式 | sandbox mode（单独当作 Codex UI 选项时）；与 Plan Mode 混称 |
| Plan Mode / 计划模式 | 与 Workflow Mode 混用；把 Plan Mode 当作 read-only 的别名 |
| Plan Approval / 计划审批 | plan permission；未说明是 Interactive Request 时 |
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
| Daemon | 后端（含糊）, 把 sidecar 或窗口当权威 |
| Desktop Shell / 桌面壳 | 桌面应用（兼指权威时） |
| Daemon Client | 把 Tauri invoke 当业务 API |
| Mobile Companion / 移动伴侣 | 独立移动应用, 云同步端 |
| Companion Server / 伴侣服务 | 中继服务, 云服务；把服务是否存在等同于移动伴侣开关 |
| Local Daemon Token / 本机守护凭证 | Pairing Token（指本机桌面连接时） |
| Pairing Token / 配对令牌 | 会话 token, API key |
| Device Pairing / 设备配对 | 登录, 普通连接；壳连回环 |
| Browser Host | iframe；Daemon 里的 WebView |
| Queued Message / 排队消息 | steering（注入进行中的一轮） |
| Immediate Run / 立即执行 | 轮中热切 / steer, 清空剩余队列 |
| Scheduled Task / 定时任务 | automation, job, workflow（当指用户可见实体时）；创建时不能改权限档
| Task Instruction / 任务指令 | prompt, system prompt |
| Schedule / 计划 | cron（用户可见名称）, timer, heartbeat |
| Task Run / 一次执行 | job execution；与 Immediate Run 混称 |
| Run Delivery / 执行去向 | 现有聊天 / 新聊天（Codex 用语） |
| Command / 命令 | 用「快捷键」代指命令；用本地化标题当 id |
| Shortcut / 快捷键 | 与 Keybinding 混用；把键位字符串本身叫 Shortcut |
| Keybinding / 键位 | 把 Cmd/Ctrl 写进存储值 |
| Mod | 在配置与匹配逻辑里硬编码 Cmd 或 Ctrl |
| Shortcut Catalog / 命令目录 | 把目录当成用户设置；在目录里塞用户自定义命令 |
| Shortcut Override / 键位覆盖 | 整份键位表物化落盘；把等于默认的覆盖当成一次修改 |
| Unbound / 显式解绑 | 用删除覆盖表达解绑；把解绑值当非法值回落到默认 |
| Reserved Keybinding / 保留键位 | 出厂默认绕开保留表 |

## Notes

- 从 AgentProviderProfile 升级到 Model Provider 时不做自动迁移；旧 registry 丢弃，用户按内置模板重新配置。
- Agent Kind Switch 的决策见 [ADR 0007](docs/adr/0007-agent-kind-switch-in-session.md)。
- 移动端决策见 [ADR 0008](docs/adr/0008-mobile-companion.md)。Daemon 权威、回环 Companion Server 与 Local Daemon Token 见 [ADR 0011](docs/adr/0011-daemon-authority-local-token.md)；Daemon 独立进程（`codemux-daemon`）与 Electron 桌面壳见 [ADR 0012](docs/adr/0012-daemon-process-electron-shell.md)，Tauri 壳已移除，ADR 0008「服务仅随移动同步开启」的表述已被 ADR 0011 修订。
- Codex App Server 迁移见 [ADR 0010](docs/adr/0010-codex-app-server-transport.md)。
- 定时任务决策见 [docs/superpowers/specs/2026-08-27-scheduled-tasks-design.md](docs/superpowers/specs/2026-08-27-scheduled-tasks-design.md)。
- 快捷键决策见 [ADR 0013](docs/adr/0013-user-configurable-keyboard-shortcuts.md)：可改键、键位覆盖三态、按物理键匹配、无修饰键的键位不得被占用。

## Out of Scope (for this feature's first cut)

- `gemini_cli`：当前未接入，不参与 Agent Kind Switch。
- 移动端（Mobile Companion）首版不含：公网中继、系统推送通知、图片/文件附件、多桌面配对、富渲染（终端/xterm、diff 全展开、语法高亮）。
- 快捷键首版不含：多段 chord 键位、整包键位方案预设、系统级（应用外）全局快捷键、键位布局重映射、插件或用户自定义命令。

