import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { HostBootstrapGate } from "./components/bootstrap/HostBootstrapGate";
import { initializeOpenCodeFreeModels } from "./hooks/useAgentModels";
import { initCompanionStreamBridge } from "./lib/companionStreamBridge";
import { initDaemonLifecycleBridge } from "./lib/daemonLifecycleBridge";
import { initScheduledTasksBridge } from "./lib/scheduledTasksBridge";
import { initBrowserHostBridge } from "./lib/browserHostBridge";
import { initBrowserVisibilitySync } from "./lib/browserVisibility";
import { initSessionsChangeBridge } from "./lib/sessionsChangeBridge";
import { initLogging } from "./lib/logger";
import "./stores/appearanceStore";
import "./styles/globals.css";
import "./styles/hljs-theme.css";

initLogging();
initCompanionStreamBridge();
initSessionsChangeBridge();
initScheduledTasksBridge();
initDaemonLifecycleBridge();
initBrowserHostBridge();
initBrowserVisibilitySync();
void initializeOpenCodeFreeModels();

// In production, block the native browser context menu (refresh, save-as, print, inspect, etc.)
// Custom React onContextMenu handlers (SessionItem, PreviewPanel, TitleBar) still work —
// they render their own menus via React state, not the native browser menu.
// 内测版本先不开启了，方便看错误日志调试问题
// if (!import.meta.env.DEV) {
//   document.addEventListener('contextmenu', (e) => e.preventDefault());
// }

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* 工单 02:宿主引导闸门 —— 浏览器/移动形态先拿到连接再挂载完整界面,
        桌面壳形态保持既有行为(直接渲染,失败由界面内覆盖层处理)。 */}
    <HostBootstrapGate>
      <App />
    </HostBootstrapGate>
  </React.StrictMode>,
);

// 启动加载态退场(index.html 内嵌 #boot):React 已挂载,立即把加载态切到
// 透明(选择器已自动处理,这里兜底显式加类),淡出后从 DOM 移除。
// 非 Electron 形态(浏览器/移动)同样受益:bundle 解析期间不再白屏。
const boot = document.getElementById("boot");
if (boot) {
  boot.classList.add("boot-hidden");
  boot.addEventListener("transitionend", () => boot.remove(), { once: true });
}
