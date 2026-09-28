import { describe, expect, it, vi } from 'vitest';

import type {
  CodemuxDesktopBridge,
  DesktopUpdaterEvent,
  DesktopUpdaterCheckResult,
} from '../../lib/desktop-bridge';
import {
  UPDATER_UNAVAILABLE_MESSAGE,
  createElectronUpdaterAdapters,
} from './electronUpdaterAdapter';

type UpdaterEventListener = (event: DesktopUpdaterEvent) => void;

function createBridgeStub() {
  const listeners: UpdaterEventListener[] = [];
  const bridge = {
    checkForUpdates: vi.fn<(result: DesktopUpdaterCheckResult) => Promise<DesktopUpdaterCheckResult>>(),
    downloadAndInstall: vi.fn<() => Promise<{ version: string | null }>>(),
    quitAndInstall: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onUpdaterEvent: vi.fn((callback: UpdaterEventListener) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }),
  } as unknown as CodemuxDesktopBridge;
  const emit = (event: DesktopUpdaterEvent) => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  return { bridge, emit, listeners };
}

describe('createElectronUpdaterAdapters(工单 06)', () => {
  it('壳返回 unavailable 时 check 抛出环境不支持错误', async () => {
    const { bridge } = createBridgeStub();
    (bridge.checkForUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'unavailable',
      version: null,
    });

    const adapters = createElectronUpdaterAdapters(bridge);
    await expect(adapters.check()).rejects.toThrow(UPDATER_UNAVAILABLE_MESSAGE);
  });

  it('壳返回 not-available 时 check 返回 null(useUpdater 走「已是最新」分支)', async () => {
    const { bridge } = createBridgeStub();
    (bridge.checkForUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'not-available',
      version: '0.3.1',
    });

    const adapters = createElectronUpdaterAdapters(bridge);
    await expect(adapters.check()).resolves.toBeNull();
  });

  it('available 时返回 UpdateHandle;downloadAndInstall 把壳事件映射为 Started/Progress/Finished', async () => {
    const { bridge, emit, listeners } = createBridgeStub();
    (bridge.checkForUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'available',
      version: '1.2.3',
    });
    let resolveInstall: (() => void) | undefined;
    (bridge.downloadAndInstall as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveInstall = resolve;
      }),
    );

    const adapters = createElectronUpdaterAdapters(bridge);
    const handle = await adapters.check();
    expect(handle?.version).toBe('1.2.3');
    expect(handle).not.toBeNull();

    const onEvent = vi.fn();
    const installPromise = handle!.downloadAndInstall(onEvent);
    await Promise.resolve(); // 让事件订阅先建立

    emit({ type: 'progress', percent: 25, transferred: 25, total: 100 });
    emit({ type: 'progress', percent: 100, transferred: 100, total: 100 });
    emit({ type: 'error', message: 'download failed' });
    emit({ type: 'downloaded', version: '1.2.3' });
    resolveInstall?.();
    await installPromise;

    expect(bridge.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls).toEqual([
      [{ event: 'Started', data: { contentLength: 100 } }],
      [{ event: 'Progress', data: { chunkLength: 25 } }],
      [{ event: 'Progress', data: { chunkLength: 75 } }],
      // 壳侧 error 事件不再被丢弃(回归:此前这里 error 完全无消费者,
      // 下载中途失败时 UI 拿不到任何信号,只等 IPC reject)。
      [{ event: 'Error', data: { message: 'download failed' } }],
      [{ event: 'Finished' }],
    ]);
    // 完成后必须取消订阅,避免泄漏/串扰下一次安装。
    expect(listeners).toHaveLength(0);
  });

  it('downloadAndInstall 失败时同样取消订阅并把错误抛给调用方', async () => {
    const { bridge, listeners } = createBridgeStub();
    (bridge.checkForUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'available',
      version: '1.2.3',
    });
    (bridge.downloadAndInstall as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const adapters = createElectronUpdaterAdapters(bridge);
    const handle = (await adapters.check())!;
    await expect(handle.downloadAndInstall(vi.fn())).rejects.toThrow('boom');
    expect(listeners).toHaveLength(0);
  });

  it('relaunch 映射为壳的 quitAndInstall(静默安装 + 自动重启)', async () => {
    const { bridge } = createBridgeStub();
    const adapters = createElectronUpdaterAdapters(bridge);
    await adapters.relaunch();
    expect(bridge.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
