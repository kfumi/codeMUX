import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
// 内置界面字体(外观设置可选,随应用打包,无需本机安装):完整单文件 woff2
// 存放于 public/fonts/(含 OFL 许可证,@font-face 见 src/styles/fonts.css),
// 字体族名与 src/lib/appearance.ts 的 BUILT_IN_FONT_FAMILIES 映射保持一致。
import "./styles/fonts.css";
import App from "./App";
import { HostBootstrapGate } from "./components/bootstrap/HostBootstrapGate";
import { initializeOpenCodeFreeModels } from "./hooks/useAgentModels";
import { initCompanionStreamBridge } from "./lib/companionStreamBridge";
import { initDaemonLifecycleBridge } from "./lib/daemonLifecycleBridge";
import { initScheduledTasksBridge } from "./lib/scheduledTasksBridge";
import { initWorkTasksBridge } from "./lib/workTasksBridge";
import { initBrowserHostBridge } from "./lib/browserHostBridge";
import { initBrowserVisibilitySync } from "./lib/browserVisibility";
import { initSessionsChangeBridge } from "./lib/sessionsChangeBridge";
import { initLogging } from "./lib/logger";
import { primeCodeHighlighting } from "./lib/codeHighlightWarmup";
import "./stores/appearanceStore";
import "./styles/globals.css";
import "./styles/hljs-theme.css";

initLogging();
initCompanionStreamBridge();
initSessionsChangeBridge();
initScheduledTasksBridge();
initWorkTasksBridge();
initDaemonLifecycleBridge();
initBrowserHostBridge();
initBrowserVisibilitySync();
void initializeOpenCodeFreeModels();
// Shiki 高亮器预热：把"第一次遇到代码块"造成的 380–420ms 主线程阻塞（集中在流式开始后
// 0.6–1.0 秒）挪到应用空闲期。实测依据、反面做法与取舍见 src/lib/codeHighlightWarmup.ts
// 顶部注释与研究文档 5.12 / 5.13 节。
primeCodeHighlighting();

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
