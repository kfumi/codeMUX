# Spec: 统一前端——桌面 / 网页 / 移动共用一套渲染层连 daemon

Status: implemented（阶段一~三已交付，三形态人工验收待补）

## Problem Statement

用户目前要通过桌面应用才能使用 CodeMUX。想在 PC 浏览器、手机浏览器上也能访问同一个 daemon 的能力（会话、时间线、项目、配置等），就像访问一个纯后端服务一样。同时，代码库里存在两套前端（桌面渲染层与移动端伴随应用），它们连的是同一个 daemon、讲的是同一套 Companion REST/WS 协议，但 API 客户端、鉴权引导、构建产物各自独立——这是长期维护负担。用户期望的终态是：**一套前端代码，三种宿主形态（Electron 壳、PC 浏览器、手机浏览器/PWA），连同一个 daemon 后端**，宿主差异只体现为能力取舍，而不是代码分叉。

## Solution

将桌面渲染层改造为宿主无关的统一前端：

1. **网页端接入**：daemon 直接提供桌面渲染层构建产物的静态服务（与现有移动端产物同机制），浏览器通过 Pairing Token 引导完成鉴权（同机 loopback 简化配对、跨机复用移动端的配对与中继通道）。
2. **响应式适配**：统一前端的布局适配窄屏/触屏，手机浏览器直接使用同一产物。
3. **收编移动端**：把移动端伴随应用的配对、中继/端到端加密、轮询回退逻辑并入统一前端，最终下线独立移动端构建，daemon 的移动端静态目录指向同一产物。

能力差异由能力清单在运行时分流：桌面全量；浏览器隐藏壳独占能力（Browser Host、窗口控制、自动更新、文件对话框等）；移动进一步精简。不改变任何既有架构决策：daemon 仍是唯一权威，所有客户端仍只讲 Companion REST/WS + CodeMUX Event（ADR 0011、0012）；非本机接入沿用 Pairing Token + Connection Offer + 中继（ADR 0009）；Local Daemon Token 仍严格限定 loopback，不为其新增浏览器下发途径。

## User Stories

1. As a desktop user, I want the existing Electron desktop experience to remain unchanged, so that the unification work does not regress my current workflow.
2. As a desktop user, I want to open CodeMUX in a local browser on the same machine, so that I can use the tool without switching windows to the desktop app.
3. As a desktop user, I want first-time browser access on loopback to pair with minimal friction (a one-click confirmation surfaced by the shell or CLI rather than manual token copying), so that onboarding is not blocked by token handling.
4. As a remote user, I want to open CodeMUX in a browser on another PC on my LAN and pair it like pairing my phone, so that I can use the same full interface from any machine.
5. As a mobile user, I want to scan the same Connection Offer QR code and land in the same unified interface, so that mobile and desktop no longer look and behave like two different products.
6. As a mobile user, I want the interface to be usable on a narrow touchscreen (collapsed navigation, chat-first view, touch-sized controls), so that I can drive sessions comfortably without a keyboard.
7. As a mobile user on a weak or relayed connection, I want the unified client to fall back to the relay/polling path transparently, so that sessions keep working when direct WebSocket is unavailable.
8. As a mobile user, I want my pairing token and connection profile persisted in the browser, so that I do not re-pair on every visit.
9. As a user, I want every protocol-backed capability (Session, 时间线回放与增量、User Message 发送与排队、审批应答、项目、配置、Model Provider、MCP、skills、定时任务、终端、git、workspace 文件、用量) to work identically regardless of host form, so that the host is purely a presentation choice.
10. As a user, I want shell-only capabilities (Browser Host、窗口控制、系统通知、文件对话框、自动更新、daemon 生命周期监管入口) to be hidden—not broken—in browser/mobile hosts, so that the UI never shows dead controls.
11. As a user, I want the built-in Browser Host entry to be visible only in the desktop shell, so that I am not confused by an unavailable feature.
12. As a user, I want a login/bootstrap screen when no daemon connection is configured, so that the browser experience has a clear entry point instead of a silent failure.
13. As a security-conscious user, I want the Companion server to validate request Origin for non-loopback sources, so that a malicious webpage cannot drive my daemon via cross-site requests once LAN exposure is on.
14. As a security-conscious user, I want the Local Daemon Token to remain loopback-only with no browser distribution path, so that the existing trust model (ADR 0011) is preserved.
15. As a developer, I want one API client implementation instead of two, so that protocol changes are made once and cannot drift between desktop and mobile.
16. As a developer, I want host differences expressed through a capability manifest consumed at runtime, so that adding a host form or hiding a capability is a data change, not a component rewrite.
17. As a developer, I want a single build artifact served to all browser-form clients, so that release engineering ships one frontend instead of two.
18. As a developer, I want the mobile-specific pairing/relay/E2EE logic to live in the shared codebase with tests, so that remote-access logic is maintained next to the protocol client it serves.
19. As a maintainer, I want the standalone mobile app retired after the unified frontend reaches parity, so that the repo no longer carries a second frontend to keep alive.
20. As a user on the desktop shell, I want desktop push notifications to keep working as today, with browser hosts offering web notifications as an optional, non-blocking fallback, so that agent completion is visible everywhere without degrading the shell experience.
21. As a user, I want the web client to recover gracefully when the daemon restarts (reconnect WS, re-fetch timeline), so that daemon upgrades mid-session do not strand the browser.
22. As a CLI user, I want no change to how the CLI reaches the daemon, so that this work stays scoped to the frontend and static serving.

## Implementation Decisions

- **接入与鉴权统一为一个 bootstrap 模块**：把现有"仅 Electron 桥注入"的 daemon 配置解析，改造为带三种引导策略的单入口——桌面壳（桥注入 Local Daemon Token）、loopback 浏览器（简化配对）、远程浏览器/移动（Pairing Token，复用移动端既有配对与 Connection Offer 机制）。桥缺失不再是硬错误，而是切换引导策略的信号。
- **鉴权令牌选择**：浏览器与移动形态一律使用 Pairing Token；不为浏览器新增 Local Daemon Token 下发端点。loopback 来源的首次配对走一次确认（由壳或 CLI 呈现），避免手工复制明文 token 文件。
- **静态服务扩展**：daemon 的 Companion server 在现有移动端静态服务机制上扩展,提供统一前端构建产物的 SPA 服务（含 not-found 回退到入口页与 no-store 缓存策略），同一产物服务所有浏览器形态客户端。
- **能力清单运行时分流**：能力清单按宿主形态（桌面壳 / 浏览器 / 移动）暴露三种能力集；shell-only 能力（Browser Host、窗口控制、托盘、通知、对话框、更新器、daemon 监管入口）在清单中收敛为条件能力，组件只消费清单，不再各自探测宿主。
- **协议客户端合并**：以桌面现有 daemon 客户端为基础，吸收移动端的配对存储、中继/端到端加密通道与轮询回退，形成单一客户端实现；两套客户端实现合并为一。
- **响应式为布局问题而非代码分叉**：统一前端用断点与能力清单驱动导航折叠、聊天主视图等窄屏行为；不为移动维护独立页面树。
- **移动端收编与退役**：将移动端伴随应用中仍被统一前端需要的逻辑（配对、Offer 编解码、中继连接、diff 展示逻辑）并入共享代码库；其后独立移动端构建退役，daemon 静态目录切换到统一产物。
- **安全加固随本工作交付**：Companion server 对非 loopback 来源增加 Origin 校验（白名单语义），覆盖 HTTP 与 WS 握手；loopback 行为不变。此项是浏览器化的前置条件而非可选项。
- **架构约束不变**：daemon 唯一权威、壳是 Supervisor、客户端只讲 Companion REST/WS + CodeMUX Event；Browser Host 仍是壳独占（其执行端在壳内），网页端本期隐藏入口，远程驱动壳内 Browser Host 不在本期。
- **分阶段交付**：阶段一网页端可用（静态服务 + 配对引导 + 能力分流 + Origin 校验）；阶段二响应式适配；阶段三收编移动端并退役独立构建。阶段一独立成立，即使后续阶段不做也有价值。

## Testing Decisions

好测试只断言外部行为：给定宿主形态的输入（桥存在与否、令牌类型、HTTP 请求头），断言引导结果与服务器响应，不断言内部实现。

- **接缝一：渲染层 bootstrap 接缝**（主接缝）。对 daemon 配置解析单入口与能力清单做纯 TypeScript 测试：mock 壳桥与网络层，断言三种宿主形态各自解析出正确的连接配置与引导路径（桥注入 / loopback 简化配对 / Pairing 引导）；能力清单测试断言三种宿主形态暴露的能力集满足"桌面 ⊇ 浏览器 ⊇ 移动中协议能力完整、shell-only 能力正确收敛"。先例：现有 daemon 门面与能力清单相关的纯逻辑测试。
- **接缝二：Companion server HTTP 层**。对 axum router 直接发请求断言：统一前端静态服务的 SPA 回退与缓存头；Origin 校验对非 loopback 请求的放行/拒绝矩阵（含 WS 握手）；loopback 行为不回归。先例：companion 模块既有的 router 级测试。
- **不测**：响应式布局与组件视觉行为不做自动化断言，靠人工验收与既有组件测试回归覆盖。

## Out of Scope

- 远程（网页/移动端）驱动壳内 Browser Host 与 CDP 自动化——本期网页端隐藏该入口，远程控制接缝留待后续。
- daemon 静态服务之外的托管形态（公网部署、多用户、集中鉴权）——CodeMUX 仍是 local-first 单用户产品。
- Local Daemon Token 的任何浏览器下发途径——违背 ADR 0011，明确不做。
- 移动端原生壳（Capacitor/React Native 等）——移动形态就是浏览器/PWA。
- 离线优先与完整 Service Worker 缓存策略——PWA 可安装性可后续单独评估。
- CLI、daemon 业务协议、Agent Kind 语义的任何变更。

## Further Notes

- 与 ADR 0011/0012 无冲突，反而是其"换壳只需替换适配器"结论的兑现；与 ADR 0009 的配对/中继机制完全复用。
- 实施前需确认仓库 `CONTEXT.md` 词汇表是否需要为新概念补词条（如"宿主形态"、"引导策略"），可通过 `/domain-modeling` 懒创建。
- 阶段三收编移动端时，注意移动端测试套件与构建脚本（含 daemon 静态目录回退链）的同步清理，避免留下死构建路径。
- 现状参考：桌面渲染层与移动端是两个独立代码库（规模约 280 vs 39 个源文件），仅共享少量连接协商代码；两套 API/WS 客户端并存是本 spec 要消除的核心重复。
