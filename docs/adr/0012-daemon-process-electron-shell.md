# ADR 0012: Daemon 独立进程与 Electron 桌面壳

## Status

Accepted(2026-09-12)

## Context

ADR 0011 确立了「Daemon 为权威、Companion Server 为唯一客户端协议、Local Daemon
Token」,但允许 Daemon 与 Tauri 壳同进程,并把「物理拆进程」留给换壳时。内置浏览
卡在系统 WebView(WebView2/wry)上——无 CDP、无可信输入,智能体网页自动化无法开展;
壳进程的生死也始终牵动权威。

## Decision

1. **Daemon 是独立进程**:同仓库 bin 目标 `codemux-daemon`(无 Tauri 依赖),拥有
   SQLite、Session、Agent、Sidecar、MCP、skills、Scheduled Task,启动即监听回环并
   写 run-state(`daemon-run-state.json`:port/pid/version/managed_by/startedAt,
   读取按 pid 存活剔除 stale)。壳永不承载权威逻辑。
2. **壳是 Daemon Supervisor**:Tauri 壳(过渡)与 Electron 壳(目标)实现同一
   supervisor 契约——决策表 Attached(健康且版本匹配)/Spawned(无 run-state)/
   Restarted(版本不匹配或不健康);版本配对以 daemon 构建版本为准;watcher 对意外
   退出清 run-state 并通知 UI;stopManaged 只杀自有 child(Windows `taskkill /F /T`
   连 sidecar 整树收尾),attach 的外部 daemon 不动。单实例锁留在壳。
3. **桌面壳是 Electron**:`desktop-electron/`(@codemux/desktop)承载窗口、托盘、
   单实例、对话框、通知(AppUserModelID=appId)、electron-updater、自定义 scheme
   加载渲染层;userData 显式指向既有应用数据目录,旧壳用户一次性安装完成迁移。
   Electron 带来真 Chromium:内置浏览为渲染层沙箱 `<webview>`(独立
   `persist:cmx-browser` partition,attach 前校验、无应用 IPC),CDP 经
   `webContents.debugger` 可用。
4. **一条协议不变**:渲染层、移动端、CLI 仍只讲 Companion REST/WS + CodeMUX Event。
   daemon→壳新增两条受控接缝,均复用既有控制面 WS 通道,不开平行协议:
   - **桌面 UI 事件出口**(`UiEventSink`):sessions-changed /
     scheduled-tasks-changed / runtime-install-progress* 由 daemon 广播,壳转发
     渲染层(Tauri 壳期是 tauri emit,Electron 期是 main 经控制面 WS 接收后
     `webContents.send` 同名转发);
   - **浏览器自动化**(`/api/browser-automation/execute|result`):仅回环 +
     Local Daemon Token;壳经 WS 收请求、FIFO 队列串行执行 eval/screenshot/
     可信 input/CDP 并回包。工具语义(aria snapshot 等)另立规格。
5. **壳门面即桥**:前端壳能力经 contextBridge(`window.codemuxDesktop`)+
   `desktop-bridge.ts` 直连 main;invoke 后端与 @tauri-apps 依赖已全部退役,
   能力清单出现 invoke 后端即测试红。

## Consequences

- 壳崩溃不再杀权威;权威升级与壳升级版本配对由 supervisor 仲裁。
- 安装包体积与内存占用上升(接受,换取真 Chromium 与壳可替换);src-tauri/ 目录
  名保留(内容为 daemon crate),重命名属纯外观,未做。
- unix 打包(mac/linux 的 daemon 命名、resources、公证)为待办;Windows 优先。
- 修订 ADR 0011 第 4 条「Desktop Shell 很薄」的表述由本 ADR 的 supervisor 契约
  具体化;其「迁移期允许同进程」过渡条款作废。
