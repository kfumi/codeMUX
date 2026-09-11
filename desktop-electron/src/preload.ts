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

const bridge = {
  // token / 目录 / 日志
  getLocalDaemonToken: () => invoke<string>('getLocalDaemonToken'),
  getAppDataDirectory: () => invoke<string>('getAppDataDirectory'),
  getUserHomeDirectory: () => invoke<string>('getUserHomeDirectory'),
  getLogDirectory: () => invoke<string>('getLogDirectory'),
  getLogFiles: () => invoke('getLogFiles'),
  readLogFile: (fileName: string) => invoke<string>('readLogFile', { fileName }),
  readHomeFile: (relativePath: string) => invoke<string>('readHomeFile', { relativePath }),

  // 资源管理器 / 项目打开
  openInExplorer: (path: string, reveal?: boolean) => invoke<void>('openInExplorer', { path, reveal }),
  openProjectPath: (path: string, target: string) => invoke<void>('openProjectPath', { path, target }),

  // 通知 / 主窗口
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }) =>
    invoke<void>('sendAgentNotification', payload),
  showMainWindow: () => invoke<void>('showMainWindow'),

  // 环境与运行时检测
  checkDevelopmentEnvironment: () => invoke('checkDevelopmentEnvironment'),
  checkAgentRuntimes: () => invoke('checkAgentRuntimes'),
  probeAgentInstallations: (agentKind: string) => invoke('probeAgentInstallations', agentKind),
  upgradeAgentRuntime: (agentKind: string) => invoke('upgradeAgentRuntime', agentKind),

  // browser.*(工单 07 迁移中;hide/show/setBounds 为 no-op,其余显式 reject)
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

  // perf / devtools
  exportPerfSnapshot: (path: string, content: string) => invoke<null>('exportPerfSnapshot', { path, content }),
  toggleDevtools: () => invoke<void>('toggleDevtools'),

  // supervisor
  daemonRestart: () => invoke('daemonRestart'),
  getDaemonInfo: () => invoke<{ port: number | null; running: boolean; version: string | null }>('getDaemonInfo'),

  // 事件
  onDaemonLifecycle,
  onAgentNotificationClicked,
};

contextBridge.exposeInMainWorld('codemuxDesktop', bridge);

export type PreloadBridge = typeof bridge;
