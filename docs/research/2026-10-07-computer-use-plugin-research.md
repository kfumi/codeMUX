# 主流 Agent Computer Use 电脑控制插件实现调研与本项目落地建议

调研日期：2026-10-07。问题：市场和开源项目中主流 Agent 的 Computer Use 电脑控制插件是怎么实现的，CodeMUX 应该怎么实现这个功能。

结论先说：行业已经收敛为同一套四层架构：感知、定位、执行、护栏。差异只在三处：截图是给模型原生看还是先转坐标，执行走操作系统原生输入还是走浏览器 CDP，能力以 MCP Server 还是以模型原生 Tool 暴露。CodeMUX 不应从零做 OS 级驱动，而应分三级渐进：先把已有的内置浏览器自动化补成 MCP 内置服务，再做桌面只读观测，最后才做受控的 OS 键鼠执行，全程复用 daemon 权威、MCP 统一管理和现有的权限审批链路。
## 一、术语先统一：Computer Use、Browser Use、OS Control 不是一回事

| 名称 | 控制面 | 感知 | 典型代表 |
|---|---|---|---|
| Browser Use | 单个浏览器页签或 WebView，DOM 加 CDP | DOM、可访问性树、截图 | 内置浏览器、Stagehand、早期 Operator 网页版 |
| Computer Use | 整个操作系统桌面，任意原生应用 | 全屏截图、可访问性树 | Anthropic Computer Use、OpenAI CUA、trycua Open-CUA、Windows-MCP |
| Grounding 解析器 | 只做自然语言到坐标，不负责决策 | 截图到坐标或元素包围盒 | 微软 OmniParser、UI-TARS 定位模型、OS-Atlas |

选型时先问用户故事要哪一层：只想让 Agent 操作网页，用 Browser Use 就够了，风险和实现量都小一个数量级；要操作聊天软件、表格软件、IDE、系统设置，才需要真正的 Computer Use。调研中几乎所有安全事故和稳定性坑都出在第二层。
## 二、市场主流方案：两家闭源旗舰加两类开放生态

### 2.1 Anthropic Computer Use

官方定位是给模型一台 Linux 虚拟机，模型自己看屏幕、动鼠标。核心是一个循环：模型决定调用哪个 computer tool，执行器在沙箱里执行并把新截图喂回去，直到任务完成或需要人工介入。

官方 computer-use-demo 仓库暴露的工具集非常小，只有四个：截图、鼠标点击、键盘输入、其余杂项。没有打开某应用这种高级语义，所有高级行为都由模型用基础动作组合出来。感知强调截图是第一公民，官方明确建议需要时再叠加可访问性树，而不是反过来。

安全设计是目前最完整的：Beta 期间要求在专用虚拟机或容器里跑，不直接碰宿主机；涉及支付、账号、隐私数据时必须人工确认；官方文档专门提示防范提示词注入。参考：Anthropic Computer use 官方文档 https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool ，示例仓库 https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo 。
### 2.2 OpenAI Operator 加 CUA 模型加 Responses API

Operator 是产品，CUA 是背后的模型，Responses API 把它开放成可编程接口。调用方传上一屏截图，模型返回下一个 computer action，调用方负责在本地执行，再把新截图传回去。和 Anthropic 的思路一致，但 OpenAI 把云端可信执行加人类确认点做成了产品特性：涉及登录、支付、验证码等敏感动作会自动停下来等人点确认。

API 侧的 computer action 类型是固定枚举，不是自由文本，这一点对 CodeMUX 有直接借鉴意义：工具参数应该是结构化的类型加坐标加按键，而不是让模型拼 shell 命令。参考：Operator 产品页 https://openai.com/index/introducing-operator/ ，Computer use 指南 https://platform.openai.com/docs/guides/tools-computer-use 。

### 2.3 微软路线：OmniParser 只做定位，UFO 只做执行编排

OmniParser 不做决策，只解决屏幕上这个按钮在哪。输入一张截图，输出结构化的可交互元素列表。UFO 则是 Windows 上的 Agent 编排层，直接调 Windows UIA 接口拿控件树。启示是解耦：定位模型可以独立升级，执行层只认坐标和控件编号。CodeMUX 如果要支持弱模型，就需要这一层；如果只接原生支持截图定位的强模型，可以先跳过。参考：https://github.com/microsoft/OmniParser ，https://github.com/microsoft/UFO 。

### 2.4 字节 UI-TARS 加 OSWorld 评测

UI-TARS 是开源的 GUI 定位决策模型，配套有桌面客户端，可以看作本地版 Operator。OSWorld 是学术界事实上的评测集：给 Agent 一台虚拟机，看它能否完成跨应用任务。对 CodeMUX 的意义是验收标准：如果将来宣称支持 Computer Use，用 OSWorld 的任务子集做回归，比自己造测试集更有说服力。参考：https://github.com/bytedance/UI-TARS-desktop ，https://os-world.github.io/ 。
## 三、开源实现拆解：五种有代表性的做法

### 3.1 trycua open-cua：最完整的端到端开源 Operator 克隆

架构是三件套：CUA 驱动、虚拟机容器护栏、Python 执行器。驱动维护与模型的对话循环，护栏隔离不可信执行，执行器用 pyautogui 负责键鼠、用 PIL 截图。它把驱动、隔离、执行三权分立，CodeMUX 可以照抄这种分层，只是把虚拟机换成 daemon 加 shell 的权限边界。参考：https://github.com/trycua/cua 。

### 3.2 Windows-MCP 类：MCP 形态的电脑控制

这类项目把电脑控制包装成 MCP Server：截图、点击、输入、取活动窗口、取界面树都是 MCP Tool。Agent 侧不需要改模型，只需要在 MCP 配置里加一个 server。这正是 CodeMUX 现有 MCP 统一管理最容易接住的形态：daemon 侧新增一个内置 MCP server，前端加一个开关，四个 runtime 通过各自的 MCP 适配器自动获得能力。典型工具粒度是截图、鼠标移动点击拖拽、按键输入、活动窗口、界面树。几乎没有项目一上来就给 shell 执行，都是先给只读观测加受控输入。参考：https://github.com/CursorTouch/Windows-MCP ，https://github.com/modelcontextprotocol/servers 。

### 3.3 纯浏览器自动化：Stagehand、Playwright MCP

只控制浏览器：截图、DOM 快照、点击选择器、输入、导航。实现靠 CDP，不碰 OS 键鼠。优点是稳定、可审计、可回放，缺点是出不了浏览器。CodeMUX 现有的 browser-automation 接缝本质上就是这一类，只是还没有 MCP 化，也没有 DOM 快照和元素级引用。

### 3.4 Grounding 专用模型：OmniParser V2、UI-TARS、OS-Atlas

输入截图加自然语言描述，输出坐标。开源 Agent 常把它当眼睛：主模型说点登录按钮，Grounding 模型返回坐标，执行器再点。这种两段式在弱模型上明显更稳，但在原生支持坐标的强模型上是多余开销。建议 CodeMUX 按可插拔设计：先直连强模型，后续在服务端加一个可选的 grounding 插槽。

### 3.5 共性细节：Set-of-Mark 加双通道感知

几乎所有稳定的开源实现都同时给模型两样东西：一张带编号标记的截图，一份结构化的元素列表。模型输出元素编号而不是裸坐标，执行器再把编号翻译回坐标。这样既利用了视觉模型的视觉能力，又避免了纯坐标幻觉。这是 CodeMUX 实现时应该默认抄的细节。
## 四、共性架构模式提炼

第一，感知层双通道：窗口截图加结构化界面状态。浏览器侧是 DOM 可访问性树，OS 侧是 UIA 控件树。只给截图，模型在密集界面上容易点偏；只给树，模型对图标、画布内容无能为力。

第二，动作空间要小而正交：截图、点击、移动拖拽、滚动、按键输入、等待六个足够。不要暴露打开某应用、执行某命令这种复合语义，复合行为由模型组合，执行器只做原子动作，便于审计和限速。

第三，坐标归一化：统一用 0 到 1000 相对坐标，执行器再换算到物理像素并处理 DPI 缩放。Windows 高 DPI 下裸像素坐标是最大的坑源，必须在执行器层收敛。

第四，循环控制器：最大步数、单步超时、停滞检测。连续多步截图无变化则停。Anthropic 和 OpenAI 都有模型说停就停、护栏说停必须停两条刹车线。

第五，护栏三件套：默认沙箱、敏感动作人工确认、完整轨迹。所有动作写审计日志，支持按会话回放。
## 五、本项目现状盘点：已有地基比想象中好

第一，daemon 是唯一权威：会话、MCP、skills、定时任务都在 daemon，客户端只走回环 Companion REST 和 WS。电脑控制能力必须也挂在 daemon 下，不能让渲染层或 sidecar 直调 OS。

第二，浏览器控制已有接缝：browser_automation 模块定义了执行接口到 WS 广播到壳串行执行到结果回填的完整链路，操作只有 eval、screenshot、input、cdp、list 五个，且受浏览器开关闸门保护。这就是浏览器级控制的雏形，缺的是 MCP 化、DOM 快照、元素引用。

第三，MCP 统一管理已成熟：SQLite 是真相源，各 agent 原生配置是投影，McpServer 有 builtin 字段。新增内置电脑控制 MCP 不需要改四个 runtime 的适配器写法，只需要注册一个内置 server 并走现有同步链路。

第四，skills 体系可承载操作手册：可以写一个 computer-use skill，告诉模型什么时候用截图、什么时候用坐标、点不准时如何放大重试，把经验沉淀成提示词而不是硬编码。

第五，权限审批链路可直接复用：已有三档权限模式和变更前确认界面。电脑控制的每一次点击输入都应走同一套审批，只是需要新增本次会话记住、单步放行两种粒度，否则用户会被弹窗淹没。

缺口：没有 OS 级截图键鼠执行器，没有 UIA 控件树采集，没有 grounding 插槽，没有轨迹回放界面。Electron 壳目前只管窗口和内置浏览，不管 OS 输入。
## 六、落地建议：三级渐进，形态统一为内置 MCP 加 skill 加审批

### 6.1 总体形态

对外永远只暴露一个东西：名为 codemux-computer 的内置 MCP Server，配一个 computer-use skill 写操作规范。Agent 通过现有 MCP 适配器自动获得能力，不需要为每个 runtime 各写一套驱动。daemon 是 MCP 的实际执行者，Electron 壳和 OS 执行器只是 daemon 的手。

### 6.2 第一级：浏览器级控制，一到两周可上线，风险最低

在现有 browser-automation 上补齐：新增 snapshot 操作，返回可访问性树加编号截图；新增 click、type、scroll、select 元素级操作，参数是元素编号不是坐标。daemon 侧新增内置 MCP server 做薄封装。前端在浏览器面板加允许 Agent 操作开关，默认关，打开后 Agent 才能调用，每次调用走现有审批。skill 写清流程：先快照，再操作，每步后截图验证。第一级完全不出浏览器，不碰 OS 键鼠，安全评审最容易过，但能覆盖帮我填表、爬页面、复现前端问题一半以上的真实需求。

### 6.3 第二级：只读桌面观测，一周，零风险

新增只读工具：桌面截图、全屏或活动窗口、活动窗口信息、窗口列表。执行器用 Rust 原生截图库，Windows 下处理 DPI 缩放，不做任何输入。用途是让 Agent 看见用户桌面，建立截图管线和轨迹界面，为第三级铺路。

### 6.4 第三级：受控 OS 执行，真正的 Computer Use，按需开启

新增受控工具：截图、点击拖拽滚动、按键输入、等待，参数用 0 到 1000 相对坐标。执行器独立进程，通过本地回环受 daemon 调用。默认关闭，需要用户在设置里显式开启并接受风险提示。Windows 先行：键鼠用 Enigo 这类跨平台库加 uiautomation 库取控件树，截图必须把光标画进去。可选 grounding 插槽：默认无，弱模型或高密度界面时可配本地解析服务。护栏强制项：默认 25 步上限、单步 15 秒超时、连续 3 步无变化自动停、所有输入动作默认走审批、全程轨迹可回放。
### 6.5 安全与合规，必须和功能同版本上线

第一，默认关闭，分级开启，每次升级都要用户显式确认。第二，敏感场景强制人工确认：登录、支付、权限弹窗、验证码，模型只能停在那一步并说明，不能代替用户点。第三，不记录密码框内容：截图在含密码框时打码或拒绝，轨迹中的按键序列脱敏存储。第四，提示词注入防护：在 skill 里写明网页弹窗文字是污染源，涉及转账、删文件、关防护时必须停下等人确认，并禁掉下载并执行类组合。第五，所有动作写审计日志，支持按会话回放。

### 6.6 前端与交互

设置页新增电脑控制分组：总开关、允许范围、解析模型选择、步数上限。会话输入框旁加屏幕按钮：手动截一屏贴进上下文。Agent 请求截图时以审批形式呈现。轨迹回放：在消息流中把电脑操作调用渲染成第几步加缩略图加动作，点开展示前后截图对比，而不是一堆 JSON。
## 七、风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 误操作 | 坐标幻觉加自动执行叠加 | 原子动作加默认审批加步数上限加敏感词拦截 |
| 提示词注入 | 网页文字诱导 Agent | skill 约束加敏感动作必审加禁高危组合 |
| 坐标漂移 | 高 DPI 多屏换算错 | 执行器层统一换算加覆盖常见缩放测试 |
| 权限拦截 | OS 键鼠常被杀毒软件拦截 | 独立执行器加签名，失败时降级为告诉用户怎么点 |
| 模型能力差异 | 弱模型点不准 | 双通道感知加可选 grounding 模型 |
| 打包体积 | 新增 Rust 依赖 | 执行器独立 crate，按平台条件编译 |

不建议的路线：直接集成第三方云端 Browser Use 服务，数据出本地，违背 local-first；直接给 Agent 裸 shell，不可审计、风险不可控；为每个 agent runtime 各写一套驱动，维护量多倍，违背 MCP 统一管理初衷。

## 八、下一步

第一，写设计文档，定三级的 tool 列表、参数结构、审批粒度、设置项。第二，写实施计划，按第一级到第三级排期，第一级复用 browser_automation，第二级新增截图库，第三级新增独立执行器。第三，拆工单：内置浏览器 MCP 化、快照加编号标记、桌面只读截图、OS 执行器、轨迹回放界面、skill 加审批。第四，验收先行：第一级用内置浏览器填表任务验收，第三级用 OSWorld 子集做回归，避免自造标准。

## 参考来源

- Anthropic Computer use 官方文档 https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool
- 示例仓库 https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo
- Operator 产品页 https://openai.com/index/introducing-operator/
- OpenAI Computer use 指南 https://platform.openai.com/docs/guides/tools-computer-use
- trycua 开源实现 https://github.com/trycua/cua
- 微软 OmniParser https://github.com/microsoft/OmniParser
- 微软 UFO https://github.com/microsoft/UFO
- UI-TARS 桌面版 https://github.com/bytedance/UI-TARS-desktop
- OSWorld 基准 https://os-world.github.io/
- Windows-MCP https://github.com/CursorTouch/Windows-MCP
- MCP Servers 目录 https://github.com/modelcontextprotocol/servers
- 本仓库 browser_automation、browser-host、内置浏览器规格、MCP 统一管理指南、权限审批指南
## 补充：可直接复用的现成开源插件

本节回答有没有写好的轮子。结论：有，按拿来即用程度分三档。第一档零代码，直接在 CodeMUX 里注册为第三方 MCP Server 就能用，走现有 MCP 统一管理同步到四个 agent。第二档抄设计不抄代码。第三档不要碰。

### 第一档：直接注册即用

Windows-MCP：Windows 整机控制，约 7800 stars，MIT，Python FastMCP，16 个工具，UIA 原生遍历加浏览器 DOM 模式，支持 stdio、SSE、streamable-http 三种传输，PyPI 可用 uvx 直接跑，地址 https://github.com/CursorTouch/Windows-MCP 。它是生态验证最充分的一个。接入成本就是在 CodeMUX 里加一条 MCP 配置。注意三点：要 Python 3.13 加 uv 环境；非英文 Windows 要关掉 App-Tool；它接管的是用户当前桌面，会抢焦点，必须配合审批和单步放行。
Playwright MCP：微软官方浏览器自动化，Apache-2.0，23 个工具，基于无障碍快照而非截图，不需要视觉模型，地址 https://github.com/microsoft/playwright-mcp 。对应 L1 的需求，但它是自己起浏览器，和 CodeMUX 侧边栏 WebView 是两套，适合先用它验证需求，再决定是否把内置浏览器 MCP 化。

computer-use-linux：Rust 写，MIT，Linux 专用，AT-SPI 语义选择器，地址 https://github.com/agent-sh/computer-use-linux 。CodeMUX 用户主力在 Windows，列为备选。

其余备选：PyMCPAutoGUI 是 PyAutoGUI 系的跨平台坐标派；computer-control-mcp 支持 HTTP 远程控制另一台机器；CodexComputerRunMCPServer 是 C# 加 .NET 10 实现，自带 skill，但星数个位数且要装运行时，均列为备选。
### 第二档：抄设计不抄代码

computer-use-windows 是一个现成的 MCP 加 SKILL 组合，skill 里写清先看屏幕尺寸和截图、每步后重新截图验证，正是推荐形态的现成例子。kompyuto 是 MCP server 加 skill 加护栏的完整形状，安全设计可抄，但它只支持 macOS 且几乎无 star。ghost 是 MIT 的 Rust 实现，Windows 完整加 Linux X11 可用，地址 https://github.com/northtekdevs/ghost ，特点是后台操作不抢焦点加动作后必验证，如果 Windows-MCP 的抢焦点问题不可接受，ghost 是第二候选。sootie 架构最全，但星数为零且许可证未明确，不能直接依赖，只能参考。

### 第三档：不要碰

Bytebot 已停止维护。任何要把数据送上云的 Browser Use 服务都违背 local-first，不考虑。

### 建议

本周就能做：把 Windows-MCP 和 Playwright MCP 作为推荐第三方 MCP 预置进 MCP 管理，默认关闭、一键启用，再配一条 computer-use skill，零 Rust 代码。真正要自研的只有三样：内置浏览器 MCP 化、审批粒度、轨迹回放界面。以后若自研 OS 执行器，ghost 和 Windows-MCP 的 UIA 代码是现成的 MIT 参考实现。
## 再补充：cua-driver 实证（2026-10-07，来自 PI-Desktop 的 Computer Use 设置页）

PI-Desktop 的实现验证了本报告的路线：后端直接采用 trycua/cua 的开源 cua-driver，三平台共用一个 Rust core，加 MCP 协议和服务循环，对外是同一套 MCP 工具面，走 stdio 对接。Windows 下用 UIA 读树、用 PostMessage 做后台输入，不抢焦点；macOS 用 SkyLight 按进程下发。同生态多个 agent 项目都把它列为第一选择，排在 pyautogui 类方案之前。

### 值得抄的五个产品细节

第一，驱动当独立二进制分发，带版本检测、一键更新、Doctor 诊断、刷新。这正好对应 CodeMUX 的 runtimes 托管机制：driver 进 runtimes 目录，daemon 管生命周期，界面只展示。

第二，允许列表加内置拒绝列表：空列表表示除拒绝外全部可操作；拒绝列表包含密码管理器、终端、锁屏、Windows 安全中心，以及宿主自己。最值得抄的是最后一条：防止 agent 操作自己的宿主窗口，避免递归失控。CodeMUX 的内置拒绝必须加上自己、安装器和更新器。

第三，急停直接杀 MCP 子进程，Esc 全局强打断。急停在进程级而不是消息级，循环控制器也要有这一级。

第四，截图只在 agent 显式调用取状态工具后出现在最近一览，不是常开录屏。隐私设计：截图按需拉取、逐条可审计，对应轨迹回放界面。

第五，第三方 driver 要做版本锁定加更新通道管理，不能静默跟最新，升级必须用户显式确认。

### 建议

把 cua-driver 列为 L3 首选评估对象：概念验证为 daemon 拉起 cua-driver 子进程，经 stdio 走 MCP，再进现有 MCP 同步链路。分发前确认其开源协议允许二进制再分发。
