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
import { notifyRendererReady } from "./lib/rendererReady";
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

// 启动 splash 转正(方案 A):App 已挂载,再等双 RAF 确保首帧合成上屏,
// 然后通知壳显示主窗口并渐隐关闭 splash。非 Electron 形态为 no-op。
notifyRendererReady();
