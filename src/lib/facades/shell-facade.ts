/**
 * 壳门面(工单 09 终态):全部壳能力直连 desktopBridge(window.codemuxDesktop)。
 *
 * Tauri 壳退役后不再存在 invoke 分流 —— 桥缺失(非 Electron 壳 / preload 未注入)
 * 时一律显式报错(requireDesktopBridge),由调用方决定是否捕获降级。
 */
import type { BrowserDataScope, BrowserHost, BrowserPageBounds } from '../browserHost';
import type { OpenTarget } from '../openTargets';
import { electronBrowserHost } from '../browser/electronBrowserHost';
import { desktopBridge, requireDesktopBridge } from '../desktop-bridge';

export const shellFacade = {
  /** 渲染层 <webview> 托管的完整 BrowserHost 实现(13 方法契约,工单 07)。 */
  browser: electronBrowserHost as BrowserHost,
  /** supervisor 提供的 daemon 重启(壳命令),daemon 断连 overlay 的重试入口。 */
  daemonRestart: (): Promise<unknown> => requireDesktopBridge().daemonRestart(),
  showMainWindow: (): Promise<void> => requireDesktopBridge().showMainWindow(),
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
    requireDesktopBridge().sendAgentNotification(payload),
  getLogDirectory: (): Promise<string> => requireDesktopBridge().getLogDirectory(),
  getAppDataDirectory: (): Promise<string> => requireDesktopBridge().getAppDataDirectory(),
  getUserHomeDirectory: (): Promise<string> => requireDesktopBridge().getUserHomeDirectory(),
  checkDevelopmentEnvironment: () => requireDesktopBridge().checkDevelopmentEnvironment(),
  getLogFiles: () => requireDesktopBridge().getLogFiles(),
  readLogFile: (fileName: string): Promise<string> => requireDesktopBridge().readLogFile(fileName),
  checkAgentRuntimes: () => requireDesktopBridge().checkAgentRuntimes(),
  upgradeAgentRuntime: (agentKind: string) => requireDesktopBridge().upgradeAgentRuntime(agentKind),
  probeAgentInstallations: (agentKind: string) => requireDesktopBridge().probeAgentInstallations(agentKind),
  openProjectPath: (path: string, target: OpenTarget): Promise<void> =>
    requireDesktopBridge().openProjectPath(path, target),
  readHomeFile: (relativePath: string): Promise<string> =>
    requireDesktopBridge().readHomeFile(relativePath),
  openInExplorer: (path: string, reveal?: boolean): Promise<void> =>
    requireDesktopBridge().openInExplorer(path, reveal),
  /**
   * 外链(工单 09):壳内走 main 侧 shell.openExternal(仅放行 http/https)。
   *
   * 浏览器形态(工单 03)没有壳桥:外链是**内容**而不是壳独占控件,不能
   * 「隐藏」,退化为新标签页打开 —— 否则消息里的链接在网页端会变成死链。
   */
  openExternal: (url: string): Promise<void> => {
    if (!desktopBridge) {
      if (typeof window !== 'undefined') {
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          // 弹窗被拦截:忽略(与壳内 openExternal 失败同等对待)。
        }
      }
      return Promise.resolve();
    }
    return desktopBridge.openExternal(url);
  },
  /** 窗口控制(工单 09,自绘标题栏):最小化 / 最大化切换 / 关闭(隐藏到托盘)。 */
  minimizeWindow: (): Promise<void> => requireDesktopBridge().minimizeWindow(),
  toggleMaximizeWindow: (): Promise<void> => requireDesktopBridge().toggleMaximizeWindow(),
  closeWindow: (): Promise<void> => requireDesktopBridge().closeWindow(),
  isWindowMaximized: (): Promise<boolean> => requireDesktopBridge().isWindowMaximized(),
  /** PerfOverlay 的快照导出:main 进程写文件并返回 null。 */
  exportPerfSnapshot: (path: string, content: string): Promise<null> =>
    requireDesktopBridge().exportPerfSnapshot(path, content),
  /** PerfOverlay 的 devtools 开关:main 侧 webContents.toggleDevTools。 */
  toggleDevtools: (): Promise<void> => requireDesktopBridge().toggleDevtools(),
};

export type ShellFacade = typeof shellFacade;

// Re-export browser types for tests
export type { BrowserDataScope, BrowserPageBounds };
