import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeSessionMock = vi.hoisted(() => vi.fn());

const getTimelineMock = vi.hoisted(() => vi.fn(async () => ({ events: [] as unknown[], seqEnd: -1 })));

vi.mock('./facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(async () => ({
    subscribeSession: subscribeSessionMock,
    getTimeline: getTimelineMock,
  })),
}));

import {
  getLastEventSequence,
  reconcileHistorySequence,
  registerDaemonSessionHandler,
  resetDaemonSessionBridge,
  resetLastEventSequence,
  setLastEventSequence,
} from './daemon-session-bridge';

describe('daemon session bridge', () => {
  beforeEach(() => {
    resetDaemonSessionBridge();
    subscribeSessionMock.mockReset();
    subscribeSessionMock.mockReturnValue(() => {});
  });

  it('skips stale timeline replay events after history hydration', async () => {
    setLastEventSequence('session-1', 4);

    let onEvent: ((event: unknown) => void) | undefined;
    subscribeSessionMock.mockImplementation((_sessionId, handlers) => {
      onEvent = handlers.onEvent;
      expect(handlers.getInitialSequence?.()).toBe(4);
      return () => {};
    });

    const received: Array<Record<string, unknown>> = [];
    registerDaemonSessionHandler('session-1', (event) => {
      // The bridge hands over the already-parsed frame so the store does not
      // have to stringify it only to parse it back.
      expect(typeof event).not.toBe('string');
      received.push(event as Record<string, unknown>);
    });

    await Promise.resolve();

    onEvent?.({ type: 'turn_finished', sequence: 4, session_id: 'session-1' });
    onEvent?.({ type: 'text_delta', sequence: 5, session_id: 'session-1', delta: 'hi' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'text_delta', sequence: 5 });
    expect(getLastEventSequence('session-1')).toBe(5);
  });

  it('rewinds the watermark when the daemon rebuilds the session timeline', async () => {
    setLastEventSequence('session-1', 1059);

    let onEvent: ((event: unknown) => void) | undefined;
    subscribeSessionMock.mockImplementation((_sessionId, handlers) => {
      onEvent = handlers.onEvent;
      return () => {};
    });

    const received: Array<Record<string, unknown>> = [];
    const resets: number[] = [];
    registerDaemonSessionHandler(
      'session-1',
      (event) => {
        received.push(event as Record<string, unknown>);
      },
      undefined,
      () => {
        resets.push(getLastEventSequence('session-1'));
      },
    );

    await Promise.resolve();

    // daemon 重建了时间线(回退 / 从原生重同步):序号空间从 0 重新编号。
    onEvent?.({ type: 'timeline_reset', session_id: 'session-1', sequence_max: 311 });
    expect(received).toEqual([]);
    expect(resets).toEqual([311]);
    expect(getLastEventSequence('session-1')).toBe(311);

    // 重建后的帧必须放行 —— 旧实现会拿 1059 的水位线把它们(含回合终止帧)全部丢掉。
    onEvent?.({ type: 'text_delta', sequence: 312, session_id: 'session-1', delta: 'hi' });
    expect(received).toHaveLength(1);
    expect(getLastEventSequence('session-1')).toBe(312);
  });

  it('reconciles a history load that lands below the watermark', () => {
    setLastEventSequence('session-2', 1059);
    expect(reconcileHistorySequence('session-2', 1200)).toBe('advanced');
    expect(getLastEventSequence('session-2')).toBe(1200);

    // 低于水位线的加载只有一个解释:时间线被重建并重新编号。
    expect(reconcileHistorySequence('session-2', 311)).toBe('reset');
    expect(getLastEventSequence('session-2')).toBe(311);

    // 空时间线(-1)不参与对账,避免把正常会话的水位线误清零。
    setLastEventSequence('session-3', 40);
    expect(reconcileHistorySequence('session-3', -1)).toBe('unchanged');
    expect(getLastEventSequence('session-3')).toBe(40);

    resetLastEventSequence('session-3');
    expect(getLastEventSequence('session-3')).toBe(-1);
  });
});
