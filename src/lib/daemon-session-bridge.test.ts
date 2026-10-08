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
  catchUpTimelineAfterSequence,
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

  it('catch-up backfills a below-watermark hole and never re-feeds accepted frames', async () => {
    // 生产实测(14:18 轮):乱序窗口里 summary(seq 86) 丢失,后续 result(seq 87)
    // 照常抬水位线 —— cursor 补拉(after 87)永远拉不回 86。补拉改为拉尾部并按
    // 「已接受序号集合」逐帧对账:洞补上,已接受的帧不重复投喂。
    setLastEventSequence('session-1', 85);

    let onEvent: ((event: unknown) => void) | undefined;
    getTimelineMock.mockImplementation(async () => ({
      events: [
        { type: 'assistant_message', sequence: 85, session_id: 'session-1' },
        { type: 'system_event', subtype: 'session_summary', sequence: 86, session_id: 'session-1' },
        { type: 'turn_finished', sequence: 87, session_id: 'session-1' },
      ],
      seqEnd: 87,
    }));
    subscribeSessionMock.mockImplementation((_sessionId, handlers) => {
      onEvent = handlers.onEvent;
      return () => {};
    });

    const received: Array<Record<string, unknown>> = [];
    registerDaemonSessionHandler('session-1', (event) => {
      received.push(event as Record<string, unknown>);
    });
    await Promise.resolve();

    // summary(86) 在乱序窗口里丢了;result(87) 正常到达并抬高水位线到 87。
    onEvent?.({ type: 'turn_finished', sequence: 87, session_id: 'session-1' });
    expect(received).toHaveLength(1);
    expect(getLastEventSequence('session-1')).toBe(87);

    await catchUpTimelineAfterSequence('session-1');

    // 尾部对账返回 85-87:85/87 已接受必须跳过,86 是洞必须补喂。
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ type: 'system_event', sequence: 86 });
    // 洞补上后水位线保持 87,不会回退。
    expect(getLastEventSequence('session-1')).toBe(87);

    // 再跑一次补拉:86 已入接受集合,不得重复投喂。
    await catchUpTimelineAfterSequence('session-1');
    expect(received).toHaveLength(2);
  });

  it('clears the accepted-sequence set when the timeline is rebuilt', async () => {
    // 时间线重建后序号空间回退:旧空间记录的「已接受」必须作废,
    // 否则重建后复用的同号帧会被补拉误判为重复而丢弃。
    getTimelineMock.mockImplementation(async () => ({
      events: [{ type: 'user_message', sequence: 5, session_id: 'session-1' }],
      seqEnd: 5,
    }));
    setLastEventSequence('session-1', 5);

    let onEvent: ((event: unknown) => void) | undefined;
    subscribeSessionMock.mockImplementation((_sessionId, handlers) => {
      onEvent = handlers.onEvent;
      return () => {};
    });

    const received: Array<Record<string, unknown>> = [];
    registerDaemonSessionHandler('session-1', (event) => {
      received.push(event as Record<string, unknown>);
    });
    // 冲刷订阅期触发的全部异步对账（reconcileSequenceAfterReconnect 等），
    // 避免它们的落地时机影响后面 reset 的断言。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLastEventSequence('session-1')).toBe(5);

    // 重建:序号空间回退到 2,旧空间接受集合(含 5)必须作废。
    onEvent?.({ type: 'timeline_reset', session_id: 'session-1', sequence_max: 2 });
    expect(getLastEventSequence('session-1')).toBe(2);

    await catchUpTimelineAfterSequence('session-1');

    // seq 5 在重建后的新空间里是「未见过的帧」,必须补喂而不是被判重复。
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'user_message', sequence: 5 });
  });

  it('below-watermark replay frames never poison a hole for catch-up', async () => {
    // 审查发现:水位线之下的 WS 回放帧若被标记「已接受」,而它恰是乱序窗口里
    // 丢掉的洞,补拉会永远跳过它 → 卡片再次永久丢失。回放帧必须只去重、不标记。
    setLastEventSequence('session-1', 87); // 87 已接受;86 是洞(未接受)

    let onEvent: ((event: unknown) => void) | undefined;
    getTimelineMock.mockImplementation(async () => ({
      events: [{ type: 'system_event', subtype: 'session_summary', sequence: 86, session_id: 'session-1' }],
      seqEnd: 87,
    }));
    subscribeSessionMock.mockImplementation((_sessionId, handlers) => {
      onEvent = handlers.onEvent;
      return () => {};
    });

    const received: Array<Record<string, unknown>> = [];
    registerDaemonSessionHandler('session-1', (event) => {
      received.push(event as Record<string, unknown>);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 重连回放把洞帧(86)又送了一遍:必须跳过投喂,但不得标记为已接受。
    onEvent?.({ type: 'system_event', subtype: 'session_summary', sequence: 86, session_id: 'session-1' });
    expect(received).toHaveLength(0);

    // 尾部对账必须把洞补上(而不是被上面的回放毒化)。
    await catchUpTimelineAfterSequence('session-1');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'system_event', sequence: 86 });

    // 再跑一次补拉:86 已入接受集合,不得重复投喂。
    await catchUpTimelineAfterSequence('session-1');
    expect(received).toHaveLength(1);
  });
});
