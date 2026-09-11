/**
 * Electron 更新器适配器(工单 06):把 desktopBridge 的 updater 通道映射到
 * useUpdater 的 UpdaterAdapters 契约 ——
 * - check → 壳 checkForUpdates;unavailable 视为环境不支持;
 * - downloadAndInstall → 订阅 onUpdaterEvent,把壳侧 progress/downloaded 事件
 *   映射为 Tauri plugin-updater 的 DownloadEvent(Started/Progress/Finished);
 * - relaunch → quitAndInstall(静默安装 + 自动重启;退出仍先停自有 daemon)。
 */
import type { CodemuxDesktopBridge } from '../../lib/desktop-bridge';
import type { DownloadEvent, UpdateHandle, UpdaterAdapters } from './hooks/useUpdater';

export const UPDATER_UNAVAILABLE_MESSAGE = '当前环境不支持更新检查，请在桌面正式环境中使用。';

export function createElectronUpdaterAdapters(bridge: CodemuxDesktopBridge): UpdaterAdapters {
  return {
    check: async (): Promise<UpdateHandle | null> => {
      const result = await bridge.checkForUpdates();
      if (result.status === 'unavailable') {
        throw new Error(UPDATER_UNAVAILABLE_MESSAGE);
      }
      if (result.status !== 'available' || !result.version) {
        return null;
      }
      const version = result.version;
      return {
        version,
        downloadAndInstall: async (
          onEvent: (event: DownloadEvent) => void,
        ): Promise<void> => {
          let started = false;
          let lastBytes = 0;
          const unsubscribe = bridge.onUpdaterEvent((event) => {
            if (event.type === 'progress') {
              if (!started) {
                started = true;
                onEvent({ event: 'Started', data: { contentLength: event.total || undefined } });
              }
              const chunk = Math.max(0, event.transferred - lastBytes);
              lastBytes = event.transferred;
              onEvent({ event: 'Progress', data: { chunkLength: chunk } });
              return;
            }
            if (event.type === 'downloaded') {
              onEvent({ event: 'Finished' });
            }
          });
          try {
            await bridge.downloadAndInstall();
          } finally {
            unsubscribe();
          }
        },
      };
    },
    relaunch: async (): Promise<void> => {
      await bridge.quitAndInstall();
    },
  };
}
