// @vitest-environment jsdom

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanionStatus } from '../types/companion';
import { companionViaDaemon } from '../lib/facades/daemon-facade';
import { resetCompanionStatusPollForTests } from '../lib/companionStatusPoll';
import { useCompanionStatus } from './useCompanionStatus';

vi.mock('../lib/facades/daemon-facade', () => ({
  companionViaDaemon: {
    getStatus: vi.fn(),
    setEnabled: vi.fn(),
    refreshPairingCode: vi.fn(),
    setRelayEnabled: vi.fn(),
    setRelayConfig: vi.fn(),
  },
}));

function companionStatus(partial: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    enabled: false,
    daemonReady: true,
    daemonError: null,
    port: 9240,
    desktopId: 'cmx_desktop_test',
    lanIp: '192.168.1.3',
    pairingCode: null,
    pairingCodeExpiresAt: null,
    pairedDevices: [],
    relay: {
      enabled: false,
      endpoint: '',
      useTls: false,
      connectionState: 'disabled',
      desktopPublicKeyB64: null,
    },
    ...partial,
  };
}

function getStatusMock() {
  return vi.mocked(companionViaDaemon.getStatus);
}

/** 让请求 promise 落地,不推进假定时器。 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** 推进一个轮询节拍,并让这次请求落地。 */
async function advanceTickAndFlush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
});

describe('useCompanionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompanionStatusPollForTests();
  });

  it('展示错误时去掉 Error: 前缀', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockRejectedValue(
      new Error('Daemon request failed: 405'),
    );

    const { result } = renderHook(() => useCompanionStatus({ polling: false }));

    await waitFor(() => expect(result.current.error).toBe('Daemon request failed: 405'));
  });

  it('开关响应直接成为新状态', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockResolvedValue(companionStatus());
    vi.mocked(companionViaDaemon.setEnabled).mockResolvedValue(
      companionStatus({ enabled: true, pairingCode: '123456' }),
    );

    const { result } = renderHook(() => useCompanionStatus({ polling: false }));
    await waitFor(() => expect(result.current.status?.enabled).toBe(false));

    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(companionViaDaemon.setEnabled).toHaveBeenCalledWith(true);
    expect(result.current.status?.enabled).toBe(true);
    expect(result.current.status?.pairingCode).toBe('123456');
    expect(result.current.busy).toBe(false);
  });
});

describe('useCompanionStatus 轮询单例', () => {
  // document.hidden 由本 describe 接管:jsdom 默认恒为 false,这里可切换。
  const visibility = { hidden: false };
  const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCompanionStatusPollForTests();
    visibility.hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => visibility.hidden,
    });
  });

  afterEach(() => {
    cleanup();
    resetCompanionStatusPollForTests();
    vi.useRealTimers();
    if (originalHiddenDescriptor) {
      Object.defineProperty(document, 'hidden', originalHiddenDescriptor);
    } else {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  it('两个消费方共用一个节拍:一个节拍只发一次 getStatus', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockImplementation(async () => companionStatus());

    const first = renderHook(() => useCompanionStatus({ pollIntervalMs: 15_000, polling: true }));
    const second = renderHook(() => useCompanionStatus({ pollIntervalMs: 12_000, polling: true }));

    // 两个订阅方同时挂载 → 只有一个请求(挂在同一个在飞请求上)。
    expect(getStatusMock()).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    expect(first.result.current.status?.port).toBe(9240);
    expect(second.result.current.status?.port).toBe(9240);
    expect(getStatusMock()).toHaveBeenCalledTimes(1);

    // 12s(两方 interval 的最小值)只有一个共享节拍,不是两条独立轮询。
    await advanceTickAndFlush(12_000);
    expect(getStatusMock()).toHaveBeenCalledTimes(2);

    await advanceTickAndFlush(12_000);
    expect(getStatusMock()).toHaveBeenCalledTimes(3);
  });

  it('内容相同的轮询结果不落状态,消费组件首帧之后零重渲染', async () => {
    const renderCount = { current: 0 };
    const seen: CompanionStatus[] = [];
    vi.mocked(companionViaDaemon.getStatus).mockImplementation(async () => {
      // 每次都是新的对象引用,但内容完全相同(daemon 的真实行为)。
      const next = companionStatus();
      seen.push(next);
      return next;
    });

    function Probe() {
      const { status, loading } = useCompanionStatus({ pollIntervalMs: 12_000, polling: true });
      renderCount.current += 1;
      return <span>{`${status?.port ?? 'none'}:${loading ? 'loading' : 'idle'}`}</span>;
    }

    render(<Probe />);
    await flushMicrotasks();

    const baseline = renderCount.current;
    expect(baseline).toBeGreaterThan(1); // 首帧(loading)+ 数据落地

    for (let i = 0; i < 3; i += 1) await advanceTickAndFlush(12_000);

    expect(getStatusMock()).toHaveBeenCalledTimes(4); // 1 次首次加载 + 3 个节拍
    expect(seen).toHaveLength(4);
    expect(seen[1]).not.toBe(seen[0]); // 前提:对象引用每次都不同
    expect(seen[1]).toEqual(seen[0]); // 前提:内容完全相同
    expect(renderCount.current).toBe(baseline); // 核心保护:零重渲染
  });

  it('轮询是静默的:tick 期间 loading 不翻回 true', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockImplementation(async () => companionStatus());

    const loadingTimeline: boolean[] = [];
    function LoadingProbe() {
      const { loading } = useCompanionStatus({ pollIntervalMs: 12_000, polling: true });
      loadingTimeline.push(loading);
      return <span>{loading ? 'loading' : 'idle'}</span>;
    }

    render(<LoadingProbe />);
    await flushMicrotasks();

    expect(loadingTimeline[0]).toBe(true); // 首次加载仍走 loading 置位
    expect(loadingTimeline[loadingTimeline.length - 1]).toBe(false);

    const settledFrames = loadingTimeline.length;
    await advanceTickAndFlush(12_000);
    await advanceTickAndFlush(12_000);

    expect(getStatusMock()).toHaveBeenCalledTimes(3);
    expect(loadingTimeline.slice(settledFrames)).not.toContain(true);
  });

  it('document.hidden 时跳过该次轮询,恢复可见时补拉一次', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockImplementation(async () => companionStatus());

    const { result } = renderHook(() => useCompanionStatus({ pollIntervalMs: 12_000, polling: true }));
    expect(getStatusMock()).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(result.current.status?.port).toBe(9240);

    visibility.hidden = true;
    await advanceTickAndFlush(12_000);
    await advanceTickAndFlush(12_000);
    expect(getStatusMock()).toHaveBeenCalledTimes(1); // 隐藏期间一个请求都不发

    visibility.hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(getStatusMock()).toHaveBeenCalledTimes(2); // 恢复可见立即补拉一次
  });
});
