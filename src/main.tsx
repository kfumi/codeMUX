import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initLogging } from "./lib/logger";
import "./styles/globals.css";
import "./styles/hljs-theme.css";

initLogging();

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
