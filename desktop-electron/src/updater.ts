//! 应用内更新器(工单 06):electron-updater + GitHub Releases。
//!
//! - feed 源来自 electron-builder.yml 的 `publish`(provider: github,
//!   owner/repo)——打包时 electron-builder 生成 resources/app-update.yml,
//!   electron-updater 运行时自动读取,代码里无需 setFeedURL。
//! - 开发/未打包环境(app.isPackaged === false)自动禁用:check 显式返回
//!   unavailable、downloadAndInstall 显式拒绝(该环境没有 app-update.yml)。
//! - autoDownload=false:下载由用户在渲染层显式确认后触发;
//!   autoInstallOnAppQuit=true:下载完成后即使不立即重启,退出时也会安装
//!   (「退出时安装」语义)。
//! - 进度/状态事件经 webContents 转发到渲染层(channel: `updater-event`),
//!   契约见 src/lib/desktop-bridge.ts 的 DesktopUpdaterEvent。

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime';

/** checkForUpdates 的返回(unavailable = 开发/未打包环境,更新器已禁用)。 */
export interface UpdaterCheckResult {
  status: 'available' | 'not-available' | 'unavailable';
  version: string | null;
}

/** 转发给渲染层的更新事件(渲染层映射为 Tauri plugin-updater 的 DownloadEvent)。 */
export type UpdaterMainEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string | null }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string | null }
  | { type: 'error'; message: string };

export interface UpdaterService {
  check(): Promise<UpdaterCheckResult>;
  downloadAndInstall(): Promise<{ version: string | null }>;
  quitAndInstall(): void;
  currentVersion(): string;
}

export function createUpdaterService(deps: {
  /** 打包判定(依赖注入便于测试;生产即 app.isPackaged)。 */
  isPackaged(): boolean;
  /** 渲染层事件出口(webContents 转发)。 */
  sendToRenderer(channel: string, payload: unknown): void;
}): UpdaterService {
  const forward = (event: UpdaterMainEvent): void => {
    deps.sendToRenderer('updater-event', event);
  };

  /** 最近一次 check/update-downloaded 得到的远端版本(downloadAndInstall 返回用)。 */
  let latestVersion: string | null = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  // 持久事件转发:渲染层在 downloadAndInstall 期间消费 progress/downloaded。
  autoUpdater.on('checking-for-update', () => forward({ type: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    latestVersion = info.version;
    forward({ type: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    forward({ type: 'not-available', version: info.version ?? null });
  });
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    forward({
      type: 'progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (event: UpdateInfo) => {
    latestVersion = event.version;
    forward({ type: 'downloaded', version: event.version ?? null });
  });
  autoUpdater.on('error', (error: Error) => {
    forward({ type: 'error', message: error?.message ?? String(error) });
  });

  return {
    check: async (): Promise<UpdaterCheckResult> => {
      if (!deps.isPackaged()) {
        return { status: 'unavailable', version: null };
      }
      // 6.x 的 UpdateCheckResult 带 isUpdateAvailable(版本比较由
      // electron-updater 完成,含 prerelease/allowDowngrade 语义)。
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        return { status: 'not-available', version: result?.updateInfo.version ?? null };
      }
      latestVersion = result.updateInfo.version;
      return { status: 'available', version: result.updateInfo.version };
    },

    downloadAndInstall: async (): Promise<{ version: string | null }> => {
      if (!deps.isPackaged()) {
        throw new Error('更新器在开发/未打包环境不可用');
      }
      // 前置 check 已缓存 updateInfo;resolve 即安装包下载完成
      // ('update-downloaded' 事件同步转发给渲染层)。此后:
      // 立即 quitAndInstall,或等 autoInstallOnAppQuit 在退出时安装。
      await autoUpdater.downloadUpdate();
      return { version: latestVersion };
    },

    quitAndInstall: (): void => {
      if (!deps.isPackaged()) {
        return;
      }
      // NSIS 静默安装 + 完成后自动重启;应用退出仍会先走壳的 before-quit
      // (停自有 daemon)再交给安装器。
      autoUpdater.quitAndInstall(true, true);
    },

    currentVersion: (): string => app.getVersion(),
  };
}
