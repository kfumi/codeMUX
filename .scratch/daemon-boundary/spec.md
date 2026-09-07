# 抽出 Daemon 边界（桌面改走 Companion 协议）

**Status:** ready-for-agent

## Problem Statement

桌面用户面对的是「一个 CodeMUX 应用」，但内部其实有两条互不相通的路：桌面窗口用 Tauri command 读写 Session 与智能体，手机 PWA 用 Companion Server 的 HTTP/WS 做同一件事。关掉「移动伴侣」等于关掉整条对外协议；桌面自己并不能当客户端。结果是桌面和手机会漂移、将来做 CLI 或多窗口没有单一入口，换桌面壳（例如为内置浏览器换 Electron）也必须把全部业务 IPC 重接一遍。

用户已经能在手机上查看并驱动桌面上的 Session，却不能指望「关窗口、开 CLI、换壳」时权威还在、协议还是同一条。内置浏览卡在系统 WebView 上，也因为业务和壳缠在一起，无法先把壳换成 Chromium 而不翻产品。

## Solution

把本机权威明确成 **Daemon**：它拥有 SQLite Timeline、Session、Agent Kind 编排、Sidecar、MCP、skills、Scheduled Task，并通过 **Companion Server** 对外说话。回环地址始终监听。桌面窗口变成一种 **Daemon Client**，和 Mobile Companion 走同一套 REST/WS 与 CodeMUX Event。**Desktop Shell** 只保留窗口、托盘、更新、原生对话框和 **Browser Host**。

局域网与中继暴露仍由用户显式开启，Device Pairing 与 Pairing Token 语义不变。本机桌面连接使用 **Local Daemon Token**，不是一台「已配对手机」。终端 PTY 属于 Daemon。浏览器页永远属于壳；本规格不换 Electron、不在系统 WebView 上堆智能体网页自动化。

分阶段把桌面从 invoke 迁到 Daemon Client，直到关窗口只藏壳、Daemon 与 Session 仍在；之后 CLI 成为第三种 Daemon Client。换壳变成替换 Browser Host 适配器，而不是重写产品。

## User Stories

### 阶段 1 — 回环 Daemon 常开

1. As a 桌面用户，我希望应用一启动本机 Daemon 就在回环地址就绪，以便桌面窗口不必先打开「移动伴侣」才能连上权威。
2. As a 桌面用户，我希望关闭「移动伴侣」后手机立刻连不上，但桌面窗口自己的会话和发送仍可用，以便局域网暴露与本机权威不是同一把开关。
3. As a 桌面用户，我希望开启「移动伴侣」时仍看到现有配对二维码、已配对设备与 Relay 开关，以便手机用法不因桌面改走协议而变化。
4. As a 系统维护者，我希望回环监听与局域网监听可独立启停，以便默认不把 Session 暴露到局域网。
5. As a 系统维护者，我希望桌面窗口用 Local Daemon Token 访问回环 Companion Server，以便本机连接不是一台伪造的已配对设备。
6. As a 系统维护者，我希望 Local Daemon Token 只存在应用数据目录、随 Daemon 生命周期轮换或绑定本机实例，以便其他用户进程不能凭空调用控制面。
7. As a 系统维护者，我希望局域网与中继请求仍只接受 Pairing Token，拒绝 Local Daemon Token，以便手机撤销与本机桌面凭证不会串用。
8. As a 系统维护者，我希望 `/health` 在仅回环模式下仍可探活，以便桌面启动时等待 Daemon 就绪。
9. As a 桌面用户，我希望 Daemon 启动失败时看到明确错误而不是空白会话列表，以便知道是本机服务没起来而不是「没有对话」。
10. As a 系统维护者，我希望现有 Companion REST/WS 业务 JSON 与 CodeMUX Event envelope 保持兼容，以便已配对的 Mobile Companion 不强制升级协议。

### 阶段 2 — 桌面只读改走协议

11. As a 桌面用户，我希望会话列表、归档入口和当前 Session 的 Timeline 来自 Companion Server，以便和手机看到同一份权威时间线。
12. As a 桌面用户，我希望打开一条 Session 时按 Event Sequence 追赶 Timeline，缺口时补拉而不是另走一条 invoke 历史接口，以便实时路径和历史路径同构。
13. As a 桌面用户，我希望项目列表与新建 Session 所需的只读 bootstrap（Agent Kind、Model Provider、Permission Snapshot 可选项）走同一套查询，以便桌面和手机的创建表单不会各读各的。
14. As a 桌面用户，我希望运行中的 CodeMUX Event 经 WebSocket 进入同一套会话 store，以便流式文字、工具卡片和 Interactive Request 不再依赖仅桌面可用的 Tauri event。
15. As a Mobile Companion 用户，我希望桌面改走协议后手机行为不变：未归档列表、尾部 Timeline、发送与审批仍可用，以便升级桌面不会摔坏已配对设备。
16. As a 只读或导入 Session 的用户，我希望桌面仍能打开历史 Timeline，且不会因为改走协议而误当成可发送会话。
17. As a 系统维护者，我希望桌面 UI 测试注入假 Daemon Client，而不是 mock 每一条 Tauri command，以便只读迁移可在无窗口下完成。

### 阶段 3 — 桌面写路径改走协议

18. As a 桌面用户，我希望新建 Session、发送 User Message、中断当前轮、响应 Interactive Request 都打到 Companion Server，以便手机上的同一条审批或排队消息与桌面抢同一权威，而不是两套命令。
19. As a 桌面用户，我希望 Queued Message、Immediate Run 与桌面 Composer 仍表现一致，只是落地改为 Daemon 转发，以便排队语义不因换传输而改变。
20. As a 桌面用户，我希望 Fork、Rewind、Agent Kind Switch、归档/取消归档、固定、只读、改标题仍生效，并且手机列表随后看到同一结果，以便控制面只有一份。
21. As a 桌面用户，我希望改 Kind Model Selection、Permission Snapshot、Plan Mode 后，下一轮按新快照驾驶，以便设置页不再写一条只有窗口能看见的旁路。
22. As a 桌面用户，我希望导入 Native Session、从 provider 刷新 Timeline、删除原生文件这类维护动作也走 Daemon，以便 CLI 以后能做同一件事。
23. As a 桌面用户，我希望协议暂时缺某一写能力时，界面给出明确「尚未迁移」而不是静默掉回 invoke，以便迁移期不会出现双写。
24. As a 系统维护者，我希望同一 Session 上桌面与手机同时发送时进入同一队列与同一 turn 规则，以便不出现两次 Turn Outcome。

### 阶段 4 — 控制面（配置、MCP、skills、定时任务、终端）

25. As a 桌面用户，我希望 Model Provider 的增删改、启用停用、测连通与拉取模型目录经 Daemon 生效，以便凭据仍只存在权威侧。
26. As a 桌面用户，我希望 MCP 服务器与 skills 的列表、启用、项目级技能仍在设置里可用，并且写入 Daemon，以便智能体下一轮读到的与界面一致。
27. As a 桌面用户，我希望创建、暂停、立即跑一条 Scheduled Task 时，即使主窗口在托盘里，到点的 Task Run 仍会创建 Session 并发出 Task Instruction，以便定时任务不绑在窗口可见性上。
28. As a 桌面用户，我希望侧边面板终端的创建、输入、输出与尺寸调整走 Daemon 上的 PTY，以便将来 CLI 或第二窗口看到的是同一终端，而不是壳进程私有的管道。
29. As a 桌面用户，我希望项目树的读目录、读文件、打开外部编辑器仍可用：读与写工作区走 Daemon，选文件夹/选文件对话框走壳，以便智能体与界面看到同一文件系统，选路径仍是原生对话框。
30. As a 桌面用户，我希望 git 变更列表、仓库状态、创建 Pull Request 等现有工作区动作经 Daemon 完成，以便这些能力不属于窗口。
31. As a 桌面用户，我希望托管 Runtime 的安装状态与诊断仍能在设置里看到，查询走 Daemon，以便 sidecar 与 SDK 运行时继续由权威拉起，而不是壳来 spawn。

### 阶段 5 — 壳与 Daemon 生命周期

32. As a 桌面用户，我希望点窗口关闭时主窗口隐藏到托盘，正在跑的 Session 与 Scheduled Task 不中断，以便「关掉窗口」不等于杀掉智能体。
33. As a 桌面用户，我希望托盘「打开」恢复主窗口并接上已有 Daemon，不必重放一遍启动会话，以便回来时 Timeline 还在。
34. As a 桌面用户，我希望托盘「退出」才停止 Daemon、Sidecar 与回环监听，以便有一个明确的关机动作。
35. As a 桌面用户，我希望应用已在托盘运行时再次启动只激活已有窗口，不拉起第二份 Daemon，以便端口与 SQLite 不被抢。
36. As a 桌面用户，我希望 Daemon 崩溃后窗口提示并提供重试，正在写的 Composer 草稿不丢，以便壳活着时还能把权威拉起来。
37. As a 系统维护者，我希望本阶段仍允许 Daemon 与壳同进程，只要逻辑上桌面 UI 不再经 invoke 做 Daemon 之事，以便先完成协议统一，物理拆进程留到换壳时。

### 阶段 6 — CLI 作为第三种 Daemon Client

38. As a 本机开发者，我希望在终端执行列 Session、看状态、发一条 User Message、中断、响应 Interactive Request，以便不打开窗口也能驱动 Daemon。
39. As a 本机开发者，我希望 CLI 连接回环 Companion Server 并使用 Local Daemon Token（或同等本机凭证），以便不必先做 Device Pairing。
40. As a 本机开发者，我希望 CLI 与桌面同时操作同一 Session 时遵守同一队列与审批规则，以便不会把窗口里的一轮打乱。
41. As a 本机开发者，我希望 `status` 能告诉我 Daemon 是否在听、移动伴侣是否对外暴露、当前有多少活跃 Session，以便排障。
42. As a 桌面用户，我希望没有安装 CLI 时桌面与手机功能完整，以便 CLI 是附加客户端而不是桌面的前提。

### 壳能力与内置浏览器（本规格只冻结边界）

43. As a 桌面用户，我希望侧边面板内置浏览、标签、元素检查和浏览器资料清除仍按现有 Browser Host 工作，以便抽 Daemon 不把网页打掉。
44. As a 桌面用户，我希望内置浏览在关闭「移动伴侣」后仍可用，以便浏览器属于壳，不属于局域网开关。
45. As a 桌面用户，我希望切走浏览器标签时页面被停放而不是因为 Daemon 重连被销毁，以便壳拥有 WebView 生命周期。
46. As a 系统维护者，我希望 Browser Host 继续是壳上的唯一浏览接缝，Daemon 本规格不创建 WebView，以便将来换 Electron 只换宿主适配器。
47. As a 系统维护者，我希望智能体网页工具、OAuth popup、CDP 与键盘隔离不在本规格实现，以免在系统 WebView 上堆将来要扔掉的能力。
48. As a Mobile Companion 用户，我希望手机上仍然没有内置浏览，以免半残 WebView。

### 安全、失败与可观测性

49. As a 桌面用户，我希望恶意网页不能调用 Daemon 或壳 IPC，以便内置浏览与权威隔离（延续现有子视图无应用 command 能力）。
50. As a 桌面用户，我希望回环端口被占用时看到可读错误和解决提示，以便本机冲突可处理。
51. As a 系统维护者，我希望 Daemon 侧日志带上 Session 与可选 Message UUID 的 Log Context，以便迁移后仍能跨层追查一轮。
52. As a 系统维护者，我希望桌面 Daemon Client 在 WS 断开后按 Event Sequence 追赶，而不是整表刷新丢失进行中的流式状态。
53. As a 系统维护者，我希望新增 Companion 路由与桌面旧 invoke 在迁移期有一份分类清单：每条业务能力要么已在协议上，要么明确仍是壳，禁止长期双写。
54. As a 中文界面用户，我希望设置里「移动伴侣」文案仍表示局域网/中继暴露，不把「Daemon 已启动」说成已经对外分享，以免误开端口。

## Implementation Decisions

### 架构原则

- **延续 ADR 0003**：实时与历史共用 CodeMUX Event；Timeline 仍在 SQLite。换传输不换事件。
- **延续 ADR 0008 / 0009 的对外模型**：Mobile Companion 仍是 thin client；Device Pairing、Pairing Token、Connection Offer、Relay/E2EE 只服务非本机客户端。中继仍然只换寻址路径，不换业务协议。
- **修正 ADR 0008 中「Companion Server 仅随移动同步开启」**：回环 Companion Server 是 Daemon 的默认客户端入口；`companion.enabled` 只控制局域网/中继暴露与配对 UI，不再等于「权威服务是否存在」。
- **权威留在 Rust**。不把 Daemon 改写成 Node，不把 sidecar 并进未来的 Electron main。Sidecar 仍由 Daemon 拉起。
- **一条协议**。禁止给桌面再发明第二套 HTTP。扩展现有 Companion REST/WS，直到桌面所需 Daemon 能力都有对应路由或已有路由可表达。
- **壳很薄**。窗口、托盘、updater、原生对话框、Browser Host、通知展示属于 Desktop Shell。主题/外观若仅影响本机窗口绘制，可留在壳；凡是 Session、凭据、智能体、工作区需要的配置进 Daemon。
- **先逻辑分离，后物理拆进程**。本规格允许 Daemon 与 Tauri 壳同进程，以「桌面 UI 是否还 invoke Daemon 之事」为完成标准。
- **迁移期禁止双写**。某一能力切到 Daemon Client 后，桌面 UI 不得再调用对应 invoke。允许短暂「协议未覆盖则功能入口隐藏或报错」，不允许同一点击既 POST 又 invoke。

### 领域切分

| 能力 | 归属 |
|------|------|
| Session、Timeline、User Message、Queued Message、Fork、Rewind、Agent Kind Switch | Daemon |
| Interactive Request / Permission Snapshot / Plan Mode / Kind Model Selection | Daemon |
| Project、工作区文件读写、git/forge | Daemon |
| Model Provider、MCP、skills、Scheduled Task、托管 Runtime、Sidecar | Daemon |
| 终端 PTY 与终端流 | Daemon |
| Device Pairing、Pairing Token、Relay、Offer | Daemon（对外控制面） |
| Browser Host（创建/导航/边界/检查注入/清资料） | Desktop Shell |
| 窗口几何、托盘、单实例、updater、系统通知弹出、文件/目录选择对话框、系统字体 | Desktop Shell |
| 将网页元素格式化为 User Message 文本 | 前端纯函数（已有）；发送仍走 Daemon |

打开外部编辑器：壳负责唤起 OS 关联程序，路径由 Daemon 或 UI 提供。不要让壳解释 git 状态。

### Local Daemon Token

- Daemon 启动回环监听时颁发，供 Desktop Shell 与本机 CLI 使用。
- 鉴权位置与 Pairing Token 相同（Authorization Bearer 或 WS query），但校验表不同：本机凭证不是 `companion_paired_devices` 行。
- 来源为回环的请求才接受 Local Daemon Token；来源为局域网/中继的请求只接受 Pairing Token。
- 关闭移动伴侣、撤销某台手机，不得使 Local Daemon Token 失效。
- 不把桌面注册成 PairedDevice 来「借用」现有 authorize。

### Companion Server 扩展

- **始终**绑定 `127.0.0.1`（端口策略：沿用现有 companion 端口或相邻回环端口，避免与局域网绑定冲突；同一端口双绑定回环+LAN 亦可，但 LAN 接口必须仍受 `companion.enabled` 与 Pairing Token 约束）。
- 只读已有：会话列表、Timeline、bootstrap、项目列表、Composer 上下文、WS 事件。
- 写路径已有：新建 Session、发消息、中断、改会话设置、权限与 Interactive Request 应答。桌面切过来时应对齐这些处理函数，而不是复制一套 agent 命令。
- **本规格要补齐到桌面可停用 invoke 的缺口**（可分批暴露，但完成标准是桌面日常路径不再 invoke）：归档/固定/只读/标题、Fork/Rewind/Agent Kind Switch、导入与原生维护、Model Provider、MCP、skills、Scheduled Task、终端流、工作区文件与 git/forge、Runtime 诊断。
- 终端流优先复用「WS 上的应用控制或二进制帧」；不要为终端再开一条仅 Tauri event 能用的旁路。若首批必须用 JSON 文本帧，也必须经 Companion WS，以便 CLI 能接。
- 协议仍为 append-only：只加字段与路由，不把 Mobile Companion 已依赖的字段改成必填。

### 桌面 Daemon Client

- 桌面 UI 的业务门面从「Tauri invoke 总表」改为 Daemon Client：同一模块供 store/hooks 调用。
- Shell 门面单独留下：Browser Host、对话框、窗口、托盘、updater。UI 代码按能力选门面，不在组件里直接 invoke。
- 连接启动顺序：壳起来 → 确保回环 Daemon → 用 Local Daemon Token 做 hello/健康检查 → 再灌会话列表。
- WS 与手机共用 CodeMUX Event 订阅语义（含 Event Sequence 追赶）。桌面不得再另订一份仅 IPC 的 sidecar 事件总线作为 Timeline 权威；sidecar 事件仍由 Daemon 写入 Timeline 再扇出。

### 生命周期

- 关闭主窗口：隐藏到托盘（保持现有主窗口行为），Daemon 继续跑。
- 退出：停 sidecar、停 Companion Server、再退出壳。
- 单实例：第二次启动激活已有窗口。
- `companion.enabled=false`：停局域网/中继与配对码，不停回环、不停 Scheduled Task。

### 内置浏览器

- 不改 Browser Host 契约，不把 WebView 句柄传入 Daemon。
- 不在本规格做 agent `browser_*`、window.open 真 popup、CDP。
- 设置里「浏览器控制 / 忽略证书」仍写壳侧配置（影响 WebView），不要塞进 Companion 配置。

### 文档与 ADR

- 实现落地后新增 ADR：Daemon 为权威、Companion Server 为唯一客户端协议、Local Daemon Token、壳与 Browser Host 分离。该 ADR 修订 ADR 0008「服务仅在开启移动同步时存在」的表述。

## Testing Decisions

好的测试只断言可观察行为：给定 Token 种类与请求来源 → 接受或 401；给定客户端调用 → Companion 路由被使用且 Timeline/队列结果符合现有领域规则；给定假 Daemon Client → UI 列出 Session、发出 User Message、追赶缺口。不断言 Tauri command 注册表、axum 内部 State、或 WebView 控件。

### 主接缝：Daemon Client（唯一对外业务接缝）

桌面 UI、未来 CLI、以及桌面组件测试都只通过 Daemon Client 说话。测试注入假客户端：

- 会话列表、Timeline 分页（tail/after/before）与 Event Sequence 缺口追赶
- 发送 User Message、中断、Interactive Request 应答如何变成客户端方法调用
- WS 断开后重连并续上 sequence，不重复应用 Turn Outcome
- 关闭移动伴侣后假客户端仍可调用（回环凭证仍有效）

Prior art：Mobile Companion 的 API/事件解析测试；内置浏览的假 Browser Host；Companion Offer 的共享纯 TS 模块。

### 次接缝：Companion Server 鉴权与暴露面

Rust/HTTP 测试（无窗口）：

- 回环 + Local Daemon Token → 200
- 回环 + Pairing Token（有效设备）→ 仍可用（本机调试不禁止手机式 Token）
- 非回环 + Local Daemon Token → 401
- 非回环 + 无效/撤销 Pairing Token → 401
- `companion.enabled=false` 时局域网接口不可达或拒绝业务，回环仍健康
- 关闭移动伴侣不删除 Local Daemon Token、不停止回环 `/health`

Prior art：配对 claim、Token 校验、Offer 生成测试。

### 分类不变量（守护双写）

一份「能力 → daemon | shell」清单的测试：桌面业务门面导出的方法都必须有 Companion 路由（或明确标为未迁移而测试断言 UI 不调用 invoke）。壳门面不得出现 Session/agent 发送。这不是 UI 测试，是门面边界测试。

### 明确不测

- 不在本规格做 Electron 壳、真 Chromium、Playwright 扫码。
- 不测 Browser Host 内部 WebView（已有内置浏览规格）。
- 不做「两个真实桌面窗口 + 真 sidecar」作为默认 CI；双客户端并发用假 Daemon 或 HTTP 测试夹具模拟两个 Client。

### 接缝确认

1. **主接缝**是 TypeScript Daemon Client（Vitest + 假客户端），桌面 UI 不再以 Tauri invoke 为业务测试接缝。
2. **次接缝**是 Companion Server 的 Token/绑定行为（无 GUI）。
3. Browser Host 保持现有接缝，本规格不新增浏览接缝。

## Out of Scope

- 将桌面壳从 Tauri 换成 Electron，或引入 Chromium/`<webview>`。
- 把 Daemon 或 sidecar 改写成 Node；给 sidecar 增加 runtime npm 依赖。
- 智能体网页自动化、OAuth popup、CDP、ARIA snapshot、键盘隔离打磨。
- 多窗口桌面、Expo 原生壳、应用商店向的独立移动 App。
- 插件系统、Paseo 式 workspace 身份重做、把 Project 模型改成 Paseo 的 directory-sync。
- 自研新的线协议替代 CodeMUX Event。
- 物理上把 Daemon 拆成独立安装的系统服务（本规格允许同进程；拆进程是换壳时的可选项）。
- 改变 Device Pairing、Relay、E2EE 的既有语义（只把它们从「服务是否存在」里拆出来）。
- Mobile Companion 功能扩张（附件、Fork、Agent Kind Switch、内置浏览）——若桌面控制面已在协议上，手机可后续接，不作为本规格交付。

## Further Notes

- 动机里「内置浏览器不够用」由换壳解决；本规格只把换壳变成可选项。未抽边界之前不要在 wry/WebView2 上继续做 Paseo 级浏览自动化。
- 建议实现顺序与用户故事阶段一致：回环与 Token → 只读 → 写路径 → 控制面 → 生命周期 → CLI。每一阶段结束时桌面与手机不得回退。
- 工单可拆为：01 领域词与能力分类清单、02 回环监听与 Local Daemon Token、03 桌面 Daemon Client 骨架与只读切换、04 写路径对齐现有 companion actions、05 控制面路由补齐、06 终端经 WS、07 托盘生命周期与开关语义、08 CLI MVP、09 双写守卫与回归。
- 参考形态是 Paseo 的「薄壳 + daemon + 统一协议」，不是它的包管理或 Electron 实现。
- 落地后更新 ADR 0008 表述，并写新 ADR 记录 Daemon / 壳 / Local Daemon Token。
