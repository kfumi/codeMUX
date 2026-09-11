# 拆出 Daemon 进程,桌面壳换 Electron

**Status:** ready-for-agent

## Problem Statement

边界改造完成后,桌面 UI 已经由 Daemon Client 走 Companion 协议,但权威进程仍是「Tauri 壳进程里的 Rust」:壳崩溃等于权威崩溃,关进程就丢掉 Session、定时任务和手机连接;壳永远绑在系统 WebView 上,内置浏览器做不了 CDP、可信输入和真实 Chromium 行为,智能体网页自动化被无限期冻结。Daemon 与壳同进程还意味着:任何第三种壳(更轻的窗口、CLI 之外的 GUI)都无法复用已验证的生命周期,壳的存亡始终牵动权威。

当初「换壳解决内置浏览器」的动机还挂着:边界规格把换壳变成可选项,但没有把它做成现实。如今桌面残余 invoke 只剩壳能力,继续留在 Tauri 里,浏览器能力的天花板(系统 WebView)不会消失。

## Solution

分两步走、一份规格交付:

**第一步(Daemon 拆独立进程)**:把 Rust 权威从壳进程拆成独立二进制。它拥有 SQLite、Session、Agent、Sidecar、MCP、skills、Scheduled Task,启动后监听回环并写 run-state(端口、pid、版本、托管方)。Tauri 壳降级为 **Daemon Supervisor**:只负责 spawn/attach/stop、版本配对、崩溃提示。壳崩溃不再杀权威;托盘退出才停自己管理的 daemon。

**第二步(壳换 Electron)**:用 Electron 重建 Desktop Shell——窗口、托盘、单实例、对话框、通知、electron-updater;Browser Host 用真 Chromium(沙箱 webview + 独立 session partition)重写,契约不变,并新增「受控自动化」方法面(eval、截图、可信输入、CDP),让 daemon 经既有 WS 控制通道远程驱动浏览器。前端、手机、sidecar、协议零改动。

完成后 Tauri 壳及其 commands 层下线:仓库里权威是一个可独立启动的 Rust 二进制,壳是一层可替换的薄窗口。

## User Stories

### 阶段 1 — Daemon 拆独立进程(Tauri 壳变 Supervisor)

1. As a 桌面用户,我希望应用启动时壳自动拉起 daemon 二进制并等它就绪,以便启动体验与今天无感。
2. As a 桌面用户,我希望已有同版本 daemon 在跑时壳直接复用而不是再拉一份,以便回环端口与 SQLite 不被抢。
3. As a 桌面用户,我希望壳与 daemon 版本不匹配时自动停旧起新,以便升级后不会连到旧权威。
4. As a 桌面用户,我希望 daemon 崩溃时窗口给出明确提示并可一键重试,正在写的 Composer 草稿不丢,以便壳活着就能把权威拉回来。
5. As a 桌面用户,我希望托盘「退出」停止壳管理的 daemon 与 sidecar,以便仍有一个唯一的明确关机动作。
6. As a 桌面用户,我希望壳崩溃或被强杀时 daemon 与手机连接不受影响,以便权威不再绑定窗口进程的生死。
7. As a 本机开发者,我希望手工先启动 daemon、后开壳时壳直接 attach,以便迭代 daemon 代码不必每次连壳重启。
8. As a 本机开发者,我希望 daemon 不带任何壳即可完整服务回环 REST/WS 与定时任务,以便用 HTTP 客户端独立验证权威。
9. As a 系统维护者,我希望 daemon 在应用数据目录写 run-state(端口、pid、版本、托管标记),以便壳和排障者不用猜端口。
10. As a 系统维护者,我希望壳只停止「自己管理的」daemon,attach 的外部 daemon 在壳退出后继续运行,以便开发者工作流不被误杀。
11. As a 系统维护者,我希望 daemon 侧状态组装不再经过 Tauri 的应用状态注入,以便权威可无窗口构建与测试。
12. As a 系统维护者,我希望 Local Daemon Token 文件契约与回环校验完全不变,以便手机、CLI 与现有鉴权测试零迁移。
13. As a 桌面用户,我希望单实例语义不变:第二次启动只激活已有窗口,不产生第二个 supervisor,以便行为可预期。
14. As a Mobile Companion 用户,我希望 daemon 拆进程后手机行为完全不变,以便这次重构对非本机客户端不可见。
15. As a 桌面用户,我希望终端 PTY 与定时任务在壳隐藏或崩溃后仍正常工作,以便这些能力确实属于 daemon 而不是窗口。

### 阶段 2 — Electron 最小壳

16. As a 桌面用户,我希望 Electron 版的窗口、关闭到托盘、托盘「打开/退出」与今天行为一致,以便肌肉记忆不失效。
17. As a 桌面用户,我希望应用内可检查更新、下载并在退出时安装,以便升级不依赖手动下安装包。
18. As a 桌面用户,我希望系统通知(审批、任务完成)带正确应用身份且点击可回跳,以便通知归组与交互正常。
19. As a 桌面用户,我希望打开文件/选目录仍弹原生对话框,选出的路径仍交给 daemon 使用,以便壳与权威分工不变。
20. As a 桌面用户,我希望「在资源管理器中显示」「用外部编辑器打开」照常工作,以便壳能力迁移不丢细节。
21. As a 已安装旧壳的用户,我希望通过一次安装迁移到 Electron 版且会话、配置、配对设备全保留,以便升级不是「重装」。
22. As a 系统维护者,我希望两套壳后端(Tauri invoke 与 Electron preload)满足同一壳门面契约并由边界测试守护,以便并存期行为可比较。
23. As a 系统维护者,我希望发布流程改为 electron-updater + GitHub Releases 并更新发布指南,以便更新通道单一可信。
24. As a 中文界面用户,我希望设置里壳相关文案与开关在 Electron 下含义不变,以便文档与习惯不作废。

### 阶段 3 — Browser Host 迁 Chromium + 自动化接缝

25. As a 桌面用户,我希望内置浏览的标签、地址栏、元素检查、浏览器资料清除在 Electron 下全部等价,以便换引擎不换用法。
26. As a 桌面用户,我希望切走浏览器标签时页面被停放而不是销毁,以便登录态与页面状态保住。
27. As a 桌面用户,我希望浏览器 guest 页面运行在独立 session partition 且没有任何应用 IPC 能力,以便恶意网页够不着 daemon 与壳。
28. As a 桌面用户,我希望内置浏览仍可用 devtools 排查页面,以便维持今天的调试体验。
29. As a 系统维护者,我希望 Browser Host 契约在 Electron 宿主全覆盖并由能力清单测试断言,以便「换壳=换适配器」不是口号。
30. As a 智能体,我希望 daemon 能经壳执行受控页面操作(eval、截图、可信输入、CDP 命令),以便网页自动化第一次真正可行。
31. As a 系统维护者,我希望自动化请求走既有 Companion WS 控制通道而非新协议,且 CDP 会话队列化,以便协议面保持一条、并发不踩踏。
32. As a 安全评审者,我希望自动化调用链只接受回环 + Local Daemon Token,以便浏览器不被未授权远程驱动。

### 阶段 4 — 下线 Tauri

33. As a 系统维护者,我希望仓库移除 Tauri 壳(窗口、托盘、updater、commands、capabilities),以便只剩一套壳要维护。
34. As a 系统维护者,我希望能力分类清单最终态只接受 Electron 壳后端,出现 Tauri invoke 即测试红,以便下线不被悄悄回退。
35. As a 桌面用户,我希望切换后桌面日常路径与迁移前功能等价,以便换壳对用户是「换引擎」而不是功能回退。
36. As a 文档读者,我希望新 ADR 记录「daemon 独立进程 + Electron 壳 + supervisor 语义」并修订 ADR 0011 的过渡表述,以便决策可追溯。

### 安全、失败与可观测性(贯穿)

37. As a 系统维护者,我希望非回环请求携带 Local Daemon Token 仍返回 401,以便拆进程不动安全模型。
38. As a 系统维护者,我希望壳与 daemon 的日志保留 Session/Message Log Context 并标明来源进程,以便跨进程追一轮仍可行。
39. As a 桌面用户,我希望端口被占用、daemon 起不来时看到可读错误与建议,以便本机冲突可自诊。
40. As a 系统维护者,我希望安装包对 Electron 应用与 daemon 二进制同一签名链,以便 Windows 信任链与公证完整。

## Implementation Decisions

### 架构原则

- **权威仍留 Rust**:daemon 是同仓库新 bin target,不改写成 Node;sidecar 仍由 daemon 拉起。
- **唯一模式**:壳永远经 supervisor spawn/attach daemon,不保留「同进程」分支(含 dev);开发期支持手工先起 daemon、壳 attach 的外部模式。
- **延续 ADR 0011 与边界规格**:Companion Server 是唯一业务协议;「禁止双写」延伸为「禁止双壳后端混用」。
- **壳依然很薄**:supervisor + 窗口/托盘/单实例/对话框/通知/updater/Browser Host;一切业务仍在 daemon。
- **退出语义维持现状**:关窗口=藏托盘;托盘退出=停 managed daemon 与 sidecar;attach 的外部 daemon 不被壳停止。不做「daemon 活过壳退出」的常驻语义,留给未来需求。

### 进程发现与生命周期

- **run-state 文件**:daemon 启动即在应用数据目录写 JSON(端口、pid、daemon 版本、托管标记、startedAt),退出时清理;壳据它发现端口与版本,stale 条目按 pid 存活检测剔除。
- **attach 规则**:run-state 存在 + 版本匹配 + `/health` 通过 → attach;版本不匹配 → 停旧起新;无 → spawn。借鉴 paseo 的 desktopManaged 标记与版本配对语义。
- **supervisor 是壳内模块**,Tauri 阶段与 Electron 阶段同一契约:start/attach/status/stop/restart;崩溃监测 = 进程退出事件 + 健康检查失败。
- **单实例锁留在壳**;daemon 不自持锁(run-state + attach 已防重复)。

### 资源定位与安装布局

- daemon 不再经 Tauri 解析路径:应用数据目录与资源根(sidecar 构建产物、移动端静态资源)由启动参数/环境注入;安装包固定布局,Electron 以 extraResource 携带 daemon 二进制与资源。
- 手机 PWA 静态服务本就在 daemon 侧,随资源根解析迁移,行为不变。
- Windows 通知身份由 Electron(设置 AppUserModelID + NSIS 快捷方式)承担,替换手写 winrt toast 与开始菜单修复脚本。
- **Electron 的 userData 显式指向现有应用数据目录(应用标识不变)**,旧壳用户一次性安装即完成迁移,零数据搬家。

### 引导与鉴权链

- Token 文件契约与回环校验完全不变;渲染层获取 token 的通道由 Tauri command 换成壳门面(supervisor 就绪后读同一文件),Electron 下后端是 preload/main IPC。
- 桌面连接顺序不变:壳起 → 确保回环 daemon → Local Daemon Token 健康检查 → 灌会话列表。

### Electron 壳构成

- electron-builder 打包(沿用现有平台支持面,Windows 优先验证),electron-updater + GitHub Releases 取代 minisign latest.json;发布指南同步更新。
- 渲染层加载打包 dist 经自定义 scheme(非 file 协议),避免本地文件限制;前端源码零改动,仅壳门面后端换实现。
- 窗口、托盘、对话框、通知用 Electron 原生模块;前端应用代码、移动端、sidecar、协议包零改动。

### Browser Host

- 用沙箱 webview + 独立 session partition 重写(paseo prior art);页面属于 DOM 布局,现有为子视图做的手工遮挡逻辑随之退役或大幅简化。
- Browser Host 契约方法在 Electron 宿主全覆盖,能力清单测试断言;guest 无应用 IPC(contextIsolation、nodeIntegration 关、attach 前校验)。
- 契约新增「受控自动化」方法面:eval、截图、可信输入、CDP 命令(CDP 经 webContents 调试器,会话队列化);daemon 经既有 WS 应用控制通道调用。**本规格只交付传输与宿主能力,工具语义另立规格。**

### 双壳并存与下线

- 迁移期两套壳后端并存,由能力清单边界测试守护同一契约;阶段 4 移除 Tauri 壳,分类清单最终态不再接受 invoke 后端。
- 新 ADR:daemon 独立进程、supervisor 语义、Electron 壳选择;修订 ADR 0011「允许同进程」的过渡表述。

## Testing Decisions

好的测试只断言可观察行为:给定 run-state 与版本组合 → supervisor 的 spawn/attach/stop 决策;给定 stub daemon 崩溃 → 壳提示并可重试;给定假壳后端 → UI 行为一致;给定回环/非回环与 token 种类 → 200/401。不断言 Electron main 内部、webview 控件或二进制构建细节。

接缝(沿用现有 4 个 + 新增 1 个):

1. **主接缝(沿用)**:TS Daemon Client + 假客户端。前端业务路径不因换壳改变,现有 Vitest 全部继续有效——这是「换壳零业务改动」的护栏。
2. **Companion 鉴权/暴露面(沿用并升格)**:无 GUI 的 HTTP 测试从「打同进程 axum」变为「直接打独立 daemon 进程」,token/绑定用例原样沿用。
3. **壳门面契约(沿用,双实现)**:能力清单边界测试继续断言 daemon/shell 归属;新增「两套壳后端满足同一壳契约」的一致性测试;下线 Tauri 后收窄为单实现。
4. **Browser Host 契约(沿用,扩展)**:假 Browser Host 继续服务 UI 测试;Electron 宿主适配器对契约全覆盖;自动化方法面以契约测试表达(请求-响应与队列化),不测真实网页。
5. **Daemon Supervisor(唯一新接缝)**:以 supervisor 契约为测试对象,用 stub daemon 可执行脚本(写 run-state、开 /health、响应 stop 信号、可配置崩溃)驱动:spawn/attach 决策表、版本不匹配重启、崩溃检测与重试、托盘退出只停 managed daemon。不依赖真 Rust 构建。

Prior art:壳门面边界测试、Companion token/绑定测试、内置浏览的假 Browser Host、Mobile Companion 的 API 测试、paseo 的 desktopManaged/版本配对语义。

明确不测:真实 Electron 窗口 e2e 不进默认 CI(沿用「双真实客户端不进 CI」的取舍);electron-updater 真实更新通道;webview 内部页面行为;安装包体积/内存指标。

## Out of Scope

- 智能体网页工具语义(aria snapshot、键盘隔离打磨、OAuth popup 流程)——自动化传输接缝就绪后另立规格。
- daemon 或 sidecar 改写 Node;daemon 做 detached 常驻(活过壳退出)。
- 移动端功能与协议变化(零接触);CLI(沿边界规格阶段 6 独立推进)。
- 多窗口、应用商店分发、自动更新灰度策略。
- 内存/安装包体积优化目标(接受 Electron 的已知代价,换取真 Chromium 与壳可替换)。
- Tauri 与 Electron 双通道长期并存发布(并存只发生在开发分支内,发布面一次性切换)。

## Further Notes

- 动机对齐:边界规格把「内置浏览器不够用」留给换壳解决;本规格兑现它,并把当初冻结的网页自动化重新打开为「接缝先行、语义后行」。
- **与 paseo 的关键差异**:其 daemon 是 Node,可用 Electron 二进制自身当运行时;本仓库 daemon 是 Rust,须把各平台编译产物内嵌进安装包(extraResource),壳↔daemon 的版本配对与签名分发是新增工程面。paseo 的 desktopManaged pid 标记、版本不匹配自动重启、stub 式生命周期测试直接借鉴。
- 风险最大的一次性工程是「Tauri 状态注入 → 显式状态结构」的机械改造(面广但无结构障碍);其余均为壳层重写,有 paseo 作参照。
- 建议工单拆分:01 run-state 契约与 daemon bin 拆分、02 Tauri 壳 supervisor 化、03 supervisor 契约测试(stub daemon)、04 Electron 壳骨架(窗口/托盘/单实例/加载 dist)、05 通知/对话框/updater 迁移、06 Browser Host Chromium 重写、07 自动化接缝(WS 控制通道 + CDP 队列)、08 发布面切换与 Tauri 下线、09 双壳一致性守卫收尾。
- 实现顺序即用户故事阶段:每阶段结束时桌面与手机不得回退;阶段 1 完成后即使放弃换壳,拆进程的收益(CLI、多窗口、权威与壳解耦)仍然成立。
