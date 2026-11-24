/**
 * Electron 更新器适配器(工单 06):把 desktopBridge 的 updater 通道映射到
 * useUpdater 的 UpdaterAdapters 契约 ——
 * - check → 壳 checkForUpdates;unavailable 视为环境不支持;
 * - download → 订阅 onUpdaterEvent,把壳侧 progress/downloaded/error 事件映射为
 *   DownloadEvent(Started/Progress/Finished/Error);**只下载不安装**;
 * - install → quitAndInstall(退出应用 + 拉起 NSIS 安装向导,用户按向导完成安装)。
 *
 * 为什么下载和安装分开:下载完成不等于可以装 —— 用户要先看到「安装指引」
 * (保存内容 → 应用退出 → 向导安装 → 完成),确认后才退出。旧版把两步合在
 * downloadAndInstall 里,下载一完就静默替换并自动重启,用户完全没有确认机会。
 *
 * 为什么要 Error:壳侧 `autoUpdater.on('error')` 是**独立于 IPC 返回值**的
 * 事件通道。下载中途失败(404、校验和不匹配、断网)时它先于 promise reject 到达,
 * 只靠 catch 兜底会丢掉这条最早、也最有诊断价值的信息。
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
        download: async (
          onEvent: (event: DownloadEvent) => void,
        ): Promise<void> => {
          let started = false;
          let lastBytes = 0;
          const unsubscribe = bridge.onUpdaterEvent((event) => {
            if (event.type === 'progress') {
              // total 未知时不能当 0 传(会被算成百分比已满),用 undefined
              // 表达「总量待定」,由 UI 退化为不确定态。
              if (!started) {
                started = true;
                onEvent({
                  event: 'Started',
                  data: { contentLength: event.total > 0 ? event.total : undefined },
                });
              }
              // transferred 是累计值,转成增量;负数(乱序/回退)按 0 兜底,
              // 保证渲染层单调累加。
              onEvent({
                event: 'Progress',
                data: { chunkLength: Math.max(0, event.transferred - lastBytes) },
              });
              lastBytes = Math.max(lastBytes, event.transferred);
              return;
            }
            if (event.type === 'downloaded') {
              onEvent({ event: 'Finished' });
              return;
            }
            if (event.type === 'error') {
              onEvent({ event: 'Error', data: { message: event.message } });
            }
          });
          try {
            await bridge.downloadUpdate();
          } finally {
            unsubscribe();
          }
        },
      };
    },
    install: async (): Promise<void> => {
      await bridge.quitAndInstall();
    },
  };
}
