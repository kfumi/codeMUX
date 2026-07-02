// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUpdate = {
  version: string;
  downloadAndInstall: (onEvent: (event: unknown) => void) => Promise<void>;
};

const setTauri = (enabled: boolean) => {
  if (enabled) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    return;
  }

  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
};

describe('useUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DEV', false);
    setTauri(true);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    setTauri(false);
  });

  it('静默自动检查在发现更新时进入 available', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockResolvedValue({
      version: '0.0.5',
      downloadAndInstall: vi.fn(async () => {}),
    });
    const relaunchMock = vi.fn(async () => {});
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('available');
    expect(result.current.version).toBe('0.0.5');
  });

  it('手动检查无更新时展示 latest 并自动回到 idle', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockResolvedValue(null);
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true, announceNoUpdate: true });
    });

    expect(result.current.stage).toBe('latest');

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(result.current.stage).toBe('idle');
  });

  it('交互式检查在 Promise 未完成前停留在 checking', async () => {
    let resolveCheck: ((value: MockUpdate | null) => void) | undefined;
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockImplementationOnce(() => new Promise((resolve) => {
      resolveCheck = resolve;
    }));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    let request: Promise<unknown>;

    await act(async () => {
      request = result.current.checkForUpdates({ interactive: true, announceNoUpdate: true });
      await Promise.resolve();
    });

    expect(result.current.stage).toBe('checking');

    await act(async () => {
      resolveCheck?.(null);
      await request;
    });

    expect(result.current.stage).toBe('latest');
  });

  it('静默检查无更新时保持 idle', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockResolvedValue(null);
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.stage).toBe('idle');
  });

  it('下载、安装并重启时推进状态并记录进度', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockResolvedValue({
      version: '0.0.5',
      downloadAndInstall,
    });
    const relaunchMock = vi.fn(async () => {});
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
      await result.current.startUpdate();
    });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('restarting');
    expect(result.current.progress).toEqual({
      totalBytes: 100,
      downloadedBytes: 100,
    });
  });

  it('下载进行中时停留在 downloading', async () => {
    let releaseDownload: (() => void) | undefined;
    const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => new Promise<void>((resolve) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      releaseDownload = () => {
        onEvent({ event: 'Finished' });
        resolve();
      };
    }));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => ({
        version: '0.0.5',
        downloadAndInstall,
      })),
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    let updatePromise: Promise<void>;

    await act(async () => {
      updatePromise = result.current.startUpdate();
      await Promise.resolve();
    });

    expect(result.current.stage).toBe('downloading');
    expect(result.current.progress).toEqual({
      totalBytes: 100,
      downloadedBytes: 40,
    });

    await act(async () => {
      releaseDownload?.();
      await updatePromise;
    });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('下载 Finished 后、relaunch 完成前进入 installing', async () => {
    let resolveRelaunch: (() => void) | undefined;
    const relaunchMock = vi.fn(async () => new Promise<void>((resolve) => {
      resolveRelaunch = resolve;
    }));
    const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 100 } });
      onEvent({ event: 'Finished' });
    });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => ({
        version: '0.0.5',
        downloadAndInstall,
      })),
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    let updatePromise: Promise<void>;

    await act(async () => {
      updatePromise = result.current.startUpdate();
      await Promise.resolve();
    });

    expect(result.current.stage).toBe('installing');
    expect(relaunchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRelaunch?.();
      await updatePromise;
    });

    expect(result.current.stage).toBe('restarting');
  });

  it('暴露 relaunch 方法供外部直接调用', async () => {
    const relaunchMock = vi.fn(async () => {});
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => null),
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.relaunch();
    });

    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('restarting');
  });

  it('resetToIdle 发生在 relaunch pending 期间时，旧 relaunch 的完成或失败不会污染状态', async () => {
    let resolveRelaunch: (() => void) | undefined;
    let rejectRelaunch: ((reason?: unknown) => void) | undefined;
    const relaunchMock = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveRelaunch = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectRelaunch = reject;
      }));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => null),
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    const firstRelaunch = result.current.relaunch();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');

    await act(async () => {
      resolveRelaunch?.();
      await firstRelaunch;
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeUndefined();

    const secondRelaunch = result.current.relaunch();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');

    await act(async () => {
      rejectRelaunch?.(new Error('stale relaunch failed'));
      await secondRelaunch;
    });

    expect(relaunchMock).toHaveBeenCalledTimes(2);
    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('手动检查失败时进入 error', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockRejectedValue(new Error('network down'));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    expect(result.current.stage).toBe('error');
    expect(result.current.error).toBe('network down');
  });

  it('手动检查失败时保留非 Error 错误对象的诊断信息', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockRejectedValue({
      message: 'failed to fetch latest.json',
      status: 0,
    });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    expect(result.current.stage).toBe('error');
    expect(result.current.error).toContain('failed to fetch latest.json');
  });

  it('手动检查设置 throwOnError 时会在失败后抛出原始错误', async () => {
    const error = new Error('network down');
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockRejectedValue(error);
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await expect(result.current.checkForUpdates({
        interactive: true,
        throwOnError: true,
      })).rejects.toBe(error);
    });

    expect(result.current.stage).toBe('error');
    expect(result.current.error).toBe('network down');
  });

  it('忽略过期检查结果，保持最新请求状态', async () => {
    let resolveFirst: ((value: MockUpdate | null) => void) | undefined;
    const checkMock = vi
      .fn<() => Promise<MockUpdate | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        version: '0.0.6',
        downloadAndInstall: vi.fn(async () => {}),
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    let firstPromise: Promise<unknown>;
    let secondPromise: Promise<unknown>;

    await act(async () => {
      firstPromise = result.current.checkForUpdates({ interactive: true });
      secondPromise = result.current.checkForUpdates({ interactive: true });
      await secondPromise;
      resolveFirst?.({
        version: '0.0.5',
        downloadAndInstall: vi.fn(async () => {}),
      });
      await firstPromise;
    });

    expect(result.current.stage).toBe('available');
    expect(result.current.version).toBe('0.0.6');
  });

  it('resetToIdle 会回到 idle、清掉当前 handle、让旧请求失效，并清理 latest 定时器', async () => {
    let resolvePendingCheck: ((value: MockUpdate | null) => void) | undefined;
    const staleDownload = vi.fn(async () => {});
    const freshDownload = vi.fn(async () => {});
    const checkMock = vi
      .fn<() => Promise<MockUpdate | null>>()
      .mockResolvedValueOnce({
        version: '0.0.5',
        downloadAndInstall: staleDownload,
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolvePendingCheck = resolve;
      }))
      .mockResolvedValueOnce({
        version: '0.0.7',
        downloadAndInstall: freshDownload,
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    expect(result.current.stage).toBe('available');
    expect(result.current.version).toBe('0.0.5');

    let pendingRequest: Promise<unknown>;

    await act(async () => {
      pendingRequest = result.current.checkForUpdates({ interactive: true });
      await Promise.resolve();
    });

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.version).toBeUndefined();

    await act(async () => {
      resolvePendingCheck?.({
        version: '0.0.6',
        downloadAndInstall: vi.fn(async () => {}),
      });
      await pendingRequest;
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.version).toBeUndefined();

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(staleDownload).not.toHaveBeenCalled();
    expect(freshDownload).toHaveBeenCalledTimes(1);
    expect(checkMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true, announceNoUpdate: true });
    });

    expect(result.current.stage).toBe('latest');

    act(() => {
      result.current.resetToIdle();
      vi.advanceTimersByTime(2100);
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.version).toBeUndefined();
  });

  it('resetToIdle 后旧的下载或重启失败不会把状态改成 error', async () => {
    let rejectDownload: ((reason?: unknown) => void) | undefined;
    const relaunchMock = vi.fn(async () => {
      throw new Error('stale relaunch failed');
    });
    const staleDownload = vi.fn(async (_onEvent: (event: unknown) => void) => new Promise<void>((_resolve, reject) => {
      rejectDownload = reject;
    }));
    const freshDownload = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 10 } });
      onEvent({ event: 'Progress', data: { chunkLength: 10 } });
      onEvent({ event: 'Finished' });
    });
    const checkMock = vi
      .fn<() => Promise<MockUpdate | null>>()
      .mockResolvedValueOnce({
        version: '0.0.5',
        downloadAndInstall: staleDownload,
      })
      .mockResolvedValueOnce({
        version: '0.0.6',
        downloadAndInstall: freshDownload,
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      relaunch: relaunchMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    const staleStart = result.current.startUpdate();

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.stage).toBe('downloading');

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');

    await act(async () => {
      rejectDownload?.(new Error('stale download failed'));
      await staleStart;
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(staleDownload).toHaveBeenCalledTimes(1);
    expect(freshDownload).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('error');
    expect(result.current.error).toBe('stale relaunch failed');
  });
});
