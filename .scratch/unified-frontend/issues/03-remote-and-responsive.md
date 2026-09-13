# 03 — 远程接入与响应式（跨机浏览器 / 手机浏览器可用）

**What to build:** 统一前端复用移动端既有机制支持非本机接入：跨机浏览器走扫码/配对码配对，直连不可用时透明回落中继/轮询；同一产物在窄屏/触屏下可用（导航折叠、聊天主视图、触屏可操作）。另补浏览器形态的通知回退（Web Notification 可选）与 daemon 重启后的 WS 重连、时间线恢复。

**Blocked by:** 02 — 网页端同机可用

**Status:** implemented（跨机配对与手机形态需人工验收）

- [ ] 局域网另一台 PC 浏览器扫码/配对码配对成功并可完整使用（代码路径就绪，待人工验收）
- [x] 直连不可用时中继/轮询回退生效，配对令牌与连接档案持久化，重复访问免配对
- [ ] 手机浏览器打开同一产物可正常操作会话，布局适配窄屏与触屏（布局已落地，待人工验收）
- [x] daemon 重启后浏览器自动重连并恢复时间线，不丢会话视图

## Comments

**2026-09-13 实现说明**

- **跨机接入复用既有机制**：`resolveRemotePairingInput` 接受配对链接（`#offer=` 自动解码）或「地址 + 6 位配对码」；`completeRemotePairing` 先直连 `POST /api/pair/claim`，失败且 offer 带中继时改用共享的 `companionHttpRequest` 经中继通道 claim。档案（desktopId / deviceId / Pairing Token / 连接列表）落 `localStorage`，下次访问 `classifyBootstrapTarget` 直接走 `paired`，不再配对。
- **轮询回退**：`profileToConnectionConfig` 对 relay-only 档案返回 `polling: true` + transport 覆盖；`createDaemonClient` 据此用 `subscribeSessionByPolling` 代替 WebSocket（2.5s 增量拉 timeline + 运行态，失败后恢复触发一次 `onReconnect`，语义与 WS 一致）。
- **daemon 重启恢复**：WS 订阅 `onclose` 后 1.2s 重连，`onReconnect` → `catchUpTimelineAfterSequence` 用 `sequence` 游标补拉缺口（既有 `daemon-session-bridge`，本工单确认它对浏览器形态同样成立：浏览器页面的 origin 端口就是 daemon 端口，重连目标不变）。
- **响应式（布局问题，不是代码分叉）**：新增 `useIsNarrowViewport`（断点与 `MOBILE_VIEWPORT_MAX_WIDTH` 共用 820px）+ `shellLayoutStore.narrowSidebarOpen`。窄屏下 `MainLayout` 把侧栏改为抽屉（遮罩 + 左滑入 + 抽屉内收起按钮 + 内容点击后自动收起），聊天列放开 `min-w-110` 最小宽度，根容器改用 `100dvh`；`SidePanel` 在窄屏直接占满内容区（复用既有 expand 分支），并隐藏拖拽改宽与「展开预览」。触屏尺寸以抽屉容器上的最小点击高度统一放宽。
- **通知回退**：`src/lib/webNotifications.ts` 提供 `resolveNotificationChannel` 纯判定 + `showWebNotification`（按会话打 tag、点击回落到会话切换、未授权静默跳过）；`useAgentNotifications` 桌面走壳通知、浏览器走 Web Notification，`NotificationSettingsSection` 在浏览器形态显示「浏览器通知 / 授权」而不是系统通知开关。
- **按 spec 的测试约定**：响应式与视觉行为不做自动化断言（人工验收），只对可判定的纯逻辑（断点判定、通道选择、引导选路、轮询增量）写单测。

**2026-09-13 修复说明（窄屏侧边面板关不掉）**

用户报障：手机/窄屏打开同一产物时，「侧边面板」空态（「打开标签页」）常驻盖住会话，点「收起面板」关不掉。

根因：窄屏改造把「展开预览」分支复用到窄屏，宽度判据写成 `isExpanded || isNarrow`，**没有同时要求面板已打开**。于是窄屏下 `width` 恒为 `100%`、`absolute inset-y-0 right-0 z-30` 恒生效；`closePanel()` 只把 `isOpen` 置 false，改不了占位，视觉上就是「关都关不掉」。

修复：`SidePanel` 的占位判据收敛为「宿主可用 **且** 已打开」——`isShown = isVisible && isOpen`、`coversContent = isShown && (isExpanded || isNarrow)`；关闭态宽度归零并回到分栏流式布局（`shrink-0`）。宽屏展开预览、窄屏打开时全屏覆盖的行为不变。

回归测试：`src/components/workspace/SidePanel.test.tsx` 新增「SidePanel 占位」5 例（窄屏关 / 窄屏开 / 宽屏分栏 / 宽屏展开 / 关闭态残留展开标记），按 `innerWidth` 切换形态断言面板的 `width` 与覆盖类名；修复前窄屏两例为红（实测 `100%`），修复后全绿。

注意：浏览器形态由 daemon 提供 `dist-web` 静态产物，窄屏验证前需 `npm run build:web`（桌面开发态走 Vite HMR，无需构建）。
