//! Sandboxed preload:经 contextBridge 暴露 `window.codemuxDesktop`。
//! contextIsolation:true + sandbox:true,渲染层拿不到 Node 能力;
//! 通道面与 shell-bridge.ts 的 `codemux:*` 注册一一对应。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(`codemux:${channel}`, payload);

/** daemon 生命周期事件订阅;返回取消订阅函数。 */
function onDaemonLifecycle(callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on('daemon-lifecycle', listener);
  return () => {
    ipcRenderer.off('daemon-lifecycle', listener);
  };
}

/**
 * 系统通知点击事件订阅(main 进程 Notification click → 转发渲染层,
 * 契约对齐 src/hooks/useAgentNotifications.ts 的 `agent-notification-clicked`);
 * 返回取消订阅函数。
 */
function onAgentNotificationClicked(callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on('agent-notification-clicked', listener);
  return () => {
    ipcRenderer.off('agent-notification-clicked', listener);
  };
}

/**
 * 更新器事件订阅(工单 06:checking/available/progress/downloaded/error,
 * 契约见 src/lib/desktop-bridge.ts 的 DesktopUpdaterEvent);返回取消订阅函数。
 */
function onUpdaterEvent(callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on('updater-event', listener);
  return () => {
    ipcRenderer.off('updater-event', listener);
  };
}

/**
 * 浏览器弹窗兜底订阅(工单 07:main 侧 guest setWindowOpenHandler deny 后
 * 转发 http/https url,渲染层开内置新标签);返回取消订阅函数。
 */
function onBrowserNewWindow(callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on('browser-new-window', listener);
  return () => {
    ipcRenderer.off('browser-new-window', listener);
  };
}

/**
 * 桌面 UI 事件订阅(工单 09):daemon 控制面 WS 广播的 ui-event 帧
 * (sessions-changed / scheduled-tasks-changed / runtime-install-progress*)
 * 经 main 按同名事件名转发;返回取消订阅函数。事件名白名单校验在 main 侧
 * (desktop-events.ts),preload 只做按名转发。
 */
function onDesktopEvent(name: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(name, listener);
  return () => {
    ipcRenderer.off(name, listener);
  };
}

const bridge = {
  // token / 目录 / 日志
  getLocalDaemonToken: () => invoke<string>('getLocalDaemonToken'),
  getAppDataDirectory: () => invoke<string>('getAppDataDirectory'),
  getUserHomeDirectory: () => invoke<string>('getUserHomeDirectory'),
  getLogDirectory: () => invoke<string>('getLogDirectory'),
  getLogFiles: () => invoke('getLogFiles'),
  readLogFile: (fileName: string) => invoke<string>('readLogFile', { fileName }),
  readHomeFile: (relativePath: string) => invoke<string>('readHomeFile', { relativePath }),
  ensureDirectory: (path: string) => invoke<boolean>('ensureDirectory', { path }),

  // 资源管理器 / 项目打开
  openInExplorer: (path: string, reveal?: boolean) => invoke<void>('openInExplorer', { path, reveal }),
  openProjectPath: (path: string, target: string) => invoke<void>('openProjectPath', { path, target }),

  // 外链(工单 09:main 仅放行 http/https,shell.openExternal)
  openExternal: (url: string) => invoke<void>('openExternal', url),

  // 窗口控制(工单 09:自绘标题栏;close = 隐藏到托盘)
  minimizeWindow: () => invoke<void>('windowMinimize'),
  toggleMaximizeWindow: () => invoke<void>('windowToggleMaximize'),
  closeWindow: () => invoke<void>('windowClose'),
  isWindowMaximized: () => invoke<boolean>('windowIsMaximized'),

  // 文件/目录对话框(工单 06;options 形状对齐 @tauri-apps/plugin-dialog,
  // 取消/关闭返回 null,multiple 为 string[])
  showDialogOpen: (options?: unknown) => invoke('showDialogOpen', options ?? {}),
  showDialogSave: (options?: unknown) => invoke('showDialogSave', options ?? {}),

  // 通知 / 主窗口
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }) =>
    invoke<void>('sendAgentNotification', payload),
  showMainWindow: () => invoke<void>('showMainWindow'),

  // 应用内更新器(工单 06;electron-updater;进度事件经 onUpdaterEvent 转发)
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadAndInstall: () => invoke('downloadAndInstall'),
  quitAndInstall: () => invoke<void>('quitAndInstall'),
  currentVersion: () => invoke<string>('currentVersion'),

  // 环境与运行时检测
  checkDevelopmentEnvironment: () => invoke('checkDevelopmentEnvironment'),
  checkAgentRuntimes: () => invoke('checkAgentRuntimes'),
  probeAgentInstallations: (agentKind: string) => invoke('probeAgentInstallations', agentKind),
  upgradeAgentRuntime: (agentKind: string) => invoke('upgradeAgentRuntime', agentKind),

  // 系统字体清单(工单 09:main 侧常见字体常量清单)
  listSystemFonts: () => invoke<string[]>('getSystemFonts'),

  // browser.*(工单 07):页面托管已迁移到渲染层 <webview>;桥面保留「清资料」
  // 与「guest 登记」数据面,其余通道为契约占位(几何 no-op,其余 reject 兜底,
  // 渲染层新适配器不再调用)。
  browserCreate: (browserId: string, url: string, bounds: unknown) =>
    invoke<void>('browserCreate', { browserId, url, bounds }),
  browserDestroy: (browserId: string) => invoke<void>('browserDestroy', { browserId }),
  browserNavigate: (browserId: string, url: string) => invoke<void>('browserNavigate', { browserId, url }),
  browserBack: (browserId: string) => invoke<void>('browserBack', { browserId }),
  browserForward: (browserId: string) => invoke<void>('browserForward', { browserId }),
  browserReload: (browserId: string) => invoke<void>('browserReload', { browserId }),
  browserSetBounds: (browserId: string, bounds: unknown) => invoke<void>('browserSetBounds', { browserId, bounds }),
  browserShow: (browserId: string) => invoke<void>('browserShow', { browserId }),
  browserHide: (browserId: string) => invoke<void>('browserHide', { browserId }),
  browserEvaluate: (browserId: string, script: string) => invoke<string>('browserEvaluate', { browserId, script }),
  browserOpenDevtools: (browserId: string) => invoke<void>('browserOpenDevtools', { browserId }),
  browserSetZoom: (browserId: string, factor: number) => invoke<void>('browserSetZoom', { browserId, factor }),
  browserClearData: (scope: string) => invoke<void>('browserClearData', { scope }),
  browserRegisterGuest: (webContentsId: number, browserId: string) =>
    invoke<void>('browserRegisterGuest', { webContentsId, browserId }),
  /** 手动贴屏(工单 04):截主屏,返回 base64 PNG 与像素尺寸。 */
  captureDesktopScreen: () => invoke<{ image: string; width: number; height: number }>('captureDesktopScreen'),
  /**
   * 全局 Esc 急停(工单 06):系统级执行开启期间武装。渲染层按配置调用,
   * 壳负责注册/解除并在触发时急停驱动 + 打断当前回合。
   */
  setEmergencyStopArmed: (armed: boolean) => invoke<boolean>('setEmergencyStopArmed', { armed }),

  // perf / devtools
  exportPerfSnapshot: (path: string, content: string) => invoke<null>('exportPerfSnapshot', { path, content }),
  toggleDevtools: () => invoke<void>('toggleDevtools'),

  // supervisor
  daemonRestart: () => invoke('daemonRestart'),
  getDaemonInfo: () => invoke<{ port: number | null; running: boolean; version: string | null }>('getDaemonInfo'),

  // 事件
  onEmergencyStop: (callback: () => void) => onDesktopEvent('emergency-stop', () => callback()),
  onDaemonLifecycle,
  onAgentNotificationClicked,
  onUpdaterEvent,
  onBrowserNewWindow,
  onDesktopEvent,
};

contextBridge.exposeInMainWorld('codemuxDesktop', bridge);

export type PreloadBridge = typeof bridge;
