# 0008 — 移动端是桌面端的远程伴侣（Mobile Companion）

移动端不是独立应用，而是桌面的远程伴侣：桌面端保留唯一的算力、配置与权威存储；移动端以浏览器 PWA 形式与桌面配对，查看并驱动桌面上的会话。智能体 runtime 必须在桌面本机运行（需要本地文件系统、终端、MCP、skills），这是架构上几乎必然的收敛。

## Status

accepted — amended 2026-09 by [ADR 0011](./0011-daemon-authority-local-token.md)

> **Amendment (daemon-boundary):** Companion Server 在桌面进程启动后于回环地址常开，不再仅随「移动伴侣」开关启动。`companion.enabled` 仅控制局域网/中继暴露与配对 UI；关闭移动伴侣不停回环、不停 Scheduled Task、不撤销 Local Daemon Token。桌面 Shell 经 Local Daemon Token 访问回环；手机仍用 Pairing Token。详见 ADR 0011。

> **Amendment (daemon-boundary, 实现面):** 开关这套管理面属于 Daemon：`/api/companion/{status,enabled,pairing-code/refresh,relay/enabled,relay/config}`。因为暴露策略是桌面本机的安全边界，这 5 条路由只接受**回环来源 + 有效令牌**，已配对手机不能远程开关。开关只重绑监听器（局域网 ↔ 回环），不重建 Daemon。

> **Amendment (unified-frontend, 2026-09):** Decision 7 中「移动端前端为同仓 `src-mobile/`」已被取代：桌面渲染层改造为宿主无关的统一前端，`src-mobile/` 与 `npm run build:mobile` 已退役。三种宿主形态（Electron 壳、PC 浏览器、手机浏览器/PWA）共用 `src/` 一套代码与 `npm run build:web` 产出的 `dist-web/`，由 daemon 的 Companion 静态服务直接提供；配对、Connection Offer、中继/E2EE 与轮询回退逻辑已并入共享客户端。本文档其余决策（thin client、桌面权威、Pairing Token、复用 CodeMUX Event、PWA 形态）不变。

## Context

用户希望能在手机上连接桌面端、实时同步对话，并在移动端使用基本功能。桌面端是 Tauri 2 应用：React/Vite 前端、Rust 后端、Node sidecar；会话权威存储是 SQLite 中的 `session_event_snapshots`（CodeMUX Event 时间线，ADR 0003）。前端经 Tauri command + event 与 Rust 通信，目前没有任何对外 HTTP/WS 服务。

智能体（Claude Code / Codex / OpenCode）在桌面本机运行，需要访问本地文件系统与终端，手机无法承载。因此移动端不可能离桌独立运行 agent。

## Decision

1. **移动端是 thin client，桌面是权威。** 桌面端默认关闭、在设置页显式开启对外服务（绑定局域网），开启后显示配对二维码；一键关闭即断开所有已配对设备。移动端不可独立工作。
2. **传输层内嵌于 Rust**（Companion Server）：新增 HTTP + WS server，而非放 sidecar。Rust 已是事件流与数据库权威；sidecar 看不到 SQLite，放 sidecar 会产生跨层回环。
3. **连接方式先局域网、后公网中继。** 首版二维码扫码配对（`局域网 IP + 一次性配对码`）换取每设备长期 Pairing Token；token 存 IndexedDB，请求与 WS 携带（WS 用 query 参数，浏览器握手不能自定义 Header）。桌面端可查看已配对设备并撤销。未来中继只换寻址路径，不换协议。
4. **实时协议复用完整 CodeMUX Event envelope**（ADR 0003）。WS 推送与桌面前端同构的事件；移动端复用 `agentEventParsing` 等纯 TS 逻辑。会话列表走定时轮询（低频），对话事件走 WS（毫秒级）。
5. **移动端功能边界（首版）：** 查看未归档会话列表与历史、实时流式跟随、在已有项目上新建会话（项目 + Agent Kind + provider + model + reasoning effort + permission config + plan mode，其余配置查询走只读 REST）、发送纯文本消息（等价于桌面队列入口，允许排队）、审批 Interactive Request（任一端响应即生效，另一端自动跟随）。不含：图片/文件附件、Agent Kind Switch、Fork、归档浏览、系统推送通知。
6. **移动端形态为 PWA，不重写原生壳。** 桌面 server 同时托管移动端静态页，扫码即打开。首版复用共享纯 TS 逻辑，DOM 组件针对手机重写（轻量渲染：markdown 正文、工具/思考折叠、文件变更降级为列表；不做 xterm/diff 富渲染）。
7. **移动端前端为同仓 `src-mobile/`。** 独立 Vite + React + Tailwind 应用，与桌面端共享类型与纯逻辑模块，共享部分继续被 vitest 覆盖。
8. **断连行为：** IndexedDB 本地只读缓存（会话列表 + 已看到的事件）+ 自动重连 + 基于 Event Sequence 的增量追赶；断连期间可看历史，发消息仍需在线。
9. **Timeline 分页同步（2026-08）：** Companion 提供 `GET /api/sessions/{id}/timeline`（`direction=tail|after|before`）。WS 连接初始只 replay 尾部页（默认 200 条）；客户端以 `sequence` 检测缺口，循环 `direction=after` 直至 `hasNewer=false`。旧 `GET .../events?after=` 保留为兼容别名。

## Considered Options

- **移动端独立完整应用（自跑 agent runtime）**——拒绝：手机无法运行依赖本地文件系统/终端的编码智能体，需重造凭据与 runtime，成本极高。
- **Companion Server 放 sidecar（node:http 现成）**——弃用：sidecar 没有 DB 访问权，历史恢复需绕回 Rust，职责边界变脏。
- **原生 App（React Native / Flutter / Tauri mobile）**——弃用：UI 组件无法复用桌面 React DOM 栈，需发布管道；PWA 扫码即用、复用纯 TS 逻辑，首版零分发成本。
- **移动端直接调用 provider API**——拒绝：凭据与配置权威在桌面，移动端不应持有。
- **移动端可新建项目 / 切换 Agent Kind / 发附件**——首版拒绝：见 Decision 5，配置操作与富交互留在桌面。
- **局域网明文 + token 信任**（而非自签 TLS）——接受：自签证书在移动浏览器有证书警告，负体验；真正的 TLS 留到公网中继阶段。

## Consequences

- 桌面端获得一个新的网络暴露面：默认关闭、显式开启，开启时局域网内可达。配对 token 是信任凭证，需支持桌面端撤销。
- Rust 侧需要新增 HTTP/WS server 依赖与异步状态管理（配对、设备、订阅者、事件扇出）。
- 移动端与桌面端共享 CodeMUX Event 语义，未来新增事件类型需保证两端的解析逻辑一致（共享纯 TS 模块）。
- 移动端新建会话需暴露项目/provider/model/effort/permission 等只读查询接口，驱动动作复用既有 Rust 命令。
- 移动端审批与桌面端共享同一条响应命令；双端状态始终一致，无需引入「审批所有权」。
- 首版局域网方案下，手机与桌面需在同一子网；跨网访问待公网中继（M4）。
