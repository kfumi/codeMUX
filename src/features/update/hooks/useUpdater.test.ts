// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUpdate = {
  version: string;
  download: (onEvent: (event: unknown) => void) => Promise<void>;
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
      download: vi.fn(async () => {}),
    });
    const installMock = vi.fn(async () => {});
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: installMock,
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
      install: vi.fn(async () => {}),
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
      install: vi.fn(async () => {}),
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
      install: vi.fn(async () => {}),
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.stage).toBe('idle');
  });

  it('下载完成后停在 ready(不自动安装)并记录进度', async () => {
    const download = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockResolvedValue({
      version: '0.0.5',
      download,
    });
    const installMock = vi.fn(async () => {});
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: installMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
      await result.current.startUpdate();
    });

    expect(download).toHaveBeenCalledTimes(1);
    // 关键回归:下载完**不**自动安装(旧版这里会直接 relaunch)。
    expect(installMock).not.toHaveBeenCalled();
    expect(result.current.stage).toBe('ready');
    expect(result.current.progress).toEqual({
      totalBytes: 100,
      downloadedBytes: 100,
    });
  });

  it('下载进行中时停留在 downloading', async () => {
    let releaseDownload: (() => void) | undefined;
    const download = vi.fn(async (onEvent: (event: unknown) => void) => new Promise<void>((resolve) => {
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
        download,
      })),
      install: vi.fn(async () => {}),
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

    expect(download).toHaveBeenCalledTimes(1);
  });

  it('下载完成后进入 ready,installUpdate 才进入 installing', async () => {
    const installMock = vi.fn(async () => {});
    const download = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 100 } });
      onEvent({ event: 'Finished' });
    });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => ({
        version: '0.0.5',
        download,
      })),
      install: installMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
      await result.current.startUpdate();
    });

    expect(result.current.stage).toBe('ready');
    expect(installMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(installMock).toHaveBeenCalledTimes(1);
    // 应用即将退出,停留在 installing(没有可回写的后续状态)。
    expect(result.current.stage).toBe('installing');
  });

  it('installUpdate 失败时进入 error', async () => {
    const installMock = vi.fn(async () => {
      throw new Error('installer missing');
    });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => null),
      install: installMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('error');
    expect(result.current.error).toBe('installer missing');
  });

  it('resetToIdle 发生在 install pending 期间时，旧 install 的完成或失败不会污染状态', async () => {
    let resolveInstall: (() => void) | undefined;
    let rejectInstall: ((reason?: unknown) => void) | undefined;
    const installMock = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveInstall = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectInstall = reject;
      }));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: vi.fn(async () => null),
      install: installMock,
    });

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    const firstInstall = result.current.installUpdate();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');

    await act(async () => {
      resolveInstall?.();
      await firstInstall;
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeUndefined();

    const secondInstall = result.current.installUpdate();

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.resetToIdle();
    });

    expect(result.current.stage).toBe('idle');

    await act(async () => {
      rejectInstall?.(new Error('stale install failed'));
      await secondInstall;
    });

    expect(installMock).toHaveBeenCalledTimes(2);
    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('手动检查失败时进入 error', async () => {
    const checkMock = vi.fn<() => Promise<MockUpdate | null>>().mockRejectedValue(new Error('network down'));
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: vi.fn(async () => {}),
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
      install: vi.fn(async () => {}),
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
      install: vi.fn(async () => {}),
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

  it('环境不支持时:interactive 进 error,throwOnError 会抛(不再静默 null 被当成「已是最新」)', async () => {
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters(null);
    // 非 Electron 壳 + DEV 态 → 环境不支持。
    vi.stubEnv('DEV', true);
    setTauri(false);

    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    // 不抛时保持原样:返回 null + error 状态(静默自动检查路径依赖这个)。
    await act(async () => {
      expect(await result.current.checkForUpdates({ interactive: true })).toBeNull();
    });
    expect(result.current.stage).toBe('error');

    await act(async () => {
      await expect(result.current.checkForUpdates({
        interactive: true,
        throwOnError: true,
      })).rejects.toThrow('当前环境不支持更新检查');
    });
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
        download: vi.fn(async () => {}),
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: vi.fn(async () => {}),
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
        download: vi.fn(async () => {}),
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
        download: staleDownload,
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolvePendingCheck = resolve;
      }))
      .mockResolvedValueOnce({
        version: '0.0.7',
        download: freshDownload,
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: vi.fn(async () => {}),
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
        download: vi.fn(async () => {}),
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

  it('resetToIdle 后旧的下载或安装失败不会把状态改成 error', async () => {
    let rejectDownload: ((reason?: unknown) => void) | undefined;
    const installMock = vi.fn(async () => {
      throw new Error('stale install failed');
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
        download: staleDownload,
      })
      .mockResolvedValueOnce({
        version: '0.0.6',
        download: freshDownload,
      });
    const { __setUpdaterTestAdapters, useUpdater } = await import('./useUpdater');
    __setUpdaterTestAdapters({
      check: checkMock,
      install: installMock,
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
    expect(result.current.stage).toBe('ready');

    // 安装是独立一步:下载完成后再装,失败才落 error。
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('error');
    expect(result.current.error).toBe('stale install failed');
  });
});
