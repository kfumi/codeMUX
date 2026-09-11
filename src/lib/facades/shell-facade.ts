import { browserApi, appApi } from './invoke-backend';
import type { BrowserDataScope, BrowserHost, BrowserPageBounds } from '../browserHost';
import type { OpenTarget } from '../openTargets';

export const shellFacade = {
  browser: browserApi as BrowserHost,
  /** supervisor 提供的 daemon 重启(壳命令),daemon 断连 overlay 的重试入口。 */
  daemonRestart: (): Promise<unknown> =>
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('daemon_restart')),
  showMainWindow: (): Promise<void> => appApi.showMainWindow(),
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
    appApi.sendAgentNotification(payload),
  getLogDirectory: appApi.getLogDirectory,
  getAppDataDirectory: appApi.getAppDataDirectory,
  getUserHomeDirectory: appApi.getUserHomeDirectory,
  checkDevelopmentEnvironment: appApi.checkDevelopmentEnvironment,
  getLogFiles: appApi.getLogFiles,
  readLogFile: appApi.readLogFile,
  checkAgentRuntimes: appApi.checkAgentRuntimes,
  upgradeAgentRuntime: appApi.upgradeAgentRuntime,
  probeAgentInstallations: appApi.probeAgentInstallations,
  openProjectPath: (path: string, target: OpenTarget): Promise<void> =>
    import('./invoke-backend').then(({ fileApi }) => fileApi.openProjectPath(path, target)),
  readHomeFile: (relativePath: string): Promise<string> =>
    import('./invoke-backend').then(({ fileApi }) => fileApi.readHomeFile(relativePath)),
};

export type ShellFacade = typeof shellFacade;

// Re-export browser types for tests
export type { BrowserDataScope, BrowserPageBounds };
