import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { initializeOpenCodeFreeModels } from "./hooks/useAgentModels";
import { initCompanionStreamBridge } from "./lib/companionStreamBridge";
import { initDaemonClient } from "./lib/daemon-bootstrap";
import { initScheduledTasksBridge } from "./lib/scheduledTasksBridge";
import { initBrowserHostBridge } from "./lib/browserHostBridge";
import { initBrowserVisibilitySync } from "./lib/browserVisibility";
import { initSessionsChangeBridge } from "./lib/sessionsChangeBridge";
import { initLogging } from "./lib/logger";
import "./styles/globals.css";
import "./styles/hljs-theme.css";

initLogging();
void initDaemonClient();
initCompanionStreamBridge();
initSessionsChangeBridge();
initScheduledTasksBridge();
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
    <App />
  </React.StrictMode>,
);
