/**
 * 壳门面(工单 09 终态):全部壳能力直连 desktopBridge(window.codemuxDesktop)。
 *
 * Tauri 壳退役后不再存在 invoke 分流 —— 桥缺失(非 Electron 壳 / preload 未注入)
 * 时一律显式报错,由调用方决定是否捕获降级。
 *
 * 报错形式是 **rejected Promise 而不是同步抛出**(工单 02 回归):渲染层普遍写
 * `void facade.x().catch(降级)` 或在 effect 里 `facade.x().then(...).catch(...)`,
 * 同步抛出会越过 `.catch` 直接冒到 React 错误边界,把浏览器形态下的整块界面
 * 渲染成「渲染错误」——因此这里统一把桥缺失/同步异常折叠成 rejection。
 */
import type { BrowserDataScope, BrowserHost, BrowserPageBounds } from '../browserHost';
import type { OpenTarget } from '../openTargets';
import { electronBrowserHost } from '../browser/electronBrowserHost';
import {
  DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE,
  desktopBridge,
  type CodemuxDesktopBridge,
} from '../desktop-bridge';

/**
 * 壳调用包装:桥缺失或壳方法同步抛出都转成 rejected Promise,
 * 保证调用方的 `.catch` / `try { await }` 一定能接住。
 */
function bridgeCall<T>(call: (bridge: CodemuxDesktopBridge) => Promise<T>): Promise<T> {
  if (!desktopBridge) {
    return Promise.reject(new Error(DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE));
  }
  try {
    return Promise.resolve(call(desktopBridge));
  } catch (error) {
    return Promise.reject(error);
  }
}

export const shellFacade = {
  /** 渲染层 <webview> 托管的完整 BrowserHost 实现(13 方法契约,工单 07)。 */
  browser: electronBrowserHost as BrowserHost,
  /** supervisor 提供的 daemon 重启(壳命令),daemon 断连 overlay 的重试入口。 */
  daemonRestart: (): Promise<unknown> => bridgeCall((bridge) => bridge.daemonRestart()),
  showMainWindow: (): Promise<void> => bridgeCall((bridge) => bridge.showMainWindow()),
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
    bridgeCall((bridge) => bridge.sendAgentNotification(payload)),
  getLogDirectory: (): Promise<string> => bridgeCall((bridge) => bridge.getLogDirectory()),
  getAppDataDirectory: (): Promise<string> => bridgeCall((bridge) => bridge.getAppDataDirectory()),
  getUserHomeDirectory: (): Promise<string> => bridgeCall((bridge) => bridge.getUserHomeDirectory()),
  checkDevelopmentEnvironment: () => bridgeCall((bridge) => bridge.checkDevelopmentEnvironment()),
  getLogFiles: () => bridgeCall((bridge) => bridge.getLogFiles()),
  readLogFile: (fileName: string): Promise<string> => bridgeCall((bridge) => bridge.readLogFile(fileName)),
  checkAgentRuntimes: () => bridgeCall((bridge) => bridge.checkAgentRuntimes()),
  upgradeAgentRuntime: (agentKind: string) => bridgeCall((bridge) => bridge.upgradeAgentRuntime(agentKind)),
  probeAgentInstallations: (agentKind: string) => bridgeCall((bridge) => bridge.probeAgentInstallations(agentKind)),
  openProjectPath: (path: string, target: OpenTarget): Promise<void> =>
    bridgeCall((bridge) => bridge.openProjectPath(path, target)),
  readHomeFile: (relativePath: string): Promise<string> =>
    bridgeCall((bridge) => bridge.readHomeFile(relativePath)),
  openInExplorer: (path: string, reveal?: boolean): Promise<void> =>
    bridgeCall((bridge) => bridge.openInExplorer(path, reveal)),
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
  minimizeWindow: (): Promise<void> => bridgeCall((bridge) => bridge.minimizeWindow()),
  toggleMaximizeWindow: (): Promise<void> => bridgeCall((bridge) => bridge.toggleMaximizeWindow()),
  closeWindow: (): Promise<void> => bridgeCall((bridge) => bridge.closeWindow()),
  isWindowMaximized: (): Promise<boolean> => bridgeCall((bridge) => bridge.isWindowMaximized()),
  /** PerfOverlay 的快照导出:main 进程写文件并返回 null。 */
  exportPerfSnapshot: (path: string, content: string): Promise<null> =>
    bridgeCall((bridge) => bridge.exportPerfSnapshot(path, content)),
  /** PerfOverlay 的 devtools 开关:main 侧 webContents.toggleDevTools。 */
  toggleDevtools: (): Promise<void> => bridgeCall((bridge) => bridge.toggleDevtools()),
};

export type ShellFacade = typeof shellFacade;

// Re-export browser types for tests
export type { BrowserDataScope, BrowserPageBounds };
