import { browserApi, appApi, configApi } from './invoke-backend';
import type { BrowserDataScope, BrowserHost, BrowserPageBounds } from '../browserHost';
import type { BrowserControlSettings } from '../../types/provider';
import type { OpenTarget } from '../openTargets';

export const shellFacade = {
  browser: browserApi as BrowserHost,
  setBrowserControl: (settings: BrowserControlSettings): Promise<void> =>
    configApi.setBrowserControl(settings),
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
