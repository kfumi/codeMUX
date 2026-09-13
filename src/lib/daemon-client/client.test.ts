import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  createDaemonClient,
  subscribeSessionByPolling,
  type DaemonConnectionConfig,
} from './client';

describe('daemon client', () => {
  const config: DaemonConnectionConfig = {
    baseUrl: 'http://127.0.0.1:9240',
    token: 'test-token',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists sessions with bearer token', async () => {
    const sessions = [{ id: 's1', title: 'Test' }];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(sessions), { status: 200 }),
    );

    const client = createDaemonClient(config);
    const result = await client.listSessions();
    expect(result).toEqual(sessions);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9240/api/sessions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('sends messages to companion route', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 202 }));

    const client = createDaemonClient(config);
    await client.sendMessage('s1', 'hello');

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9240/api/sessions/s1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

/**
 * 轮询回退(工单 02/03):中继通道没有可升级的 WebSocket,浏览器必须仍能
 * 收到增量时间线与运行态。断言只看外部行为 —— 请求了什么、回调收到了什么。
 */
describe('subscribeSessionByPolling', () => {
  const paths: string[] = [];
  let timelineEvents: Array<Record<string, unknown>> = [];
  let failNext = false;

  const pollingConfig: DaemonConnectionConfig = {
    baseUrl: 'http://relay.test',
    token: 'relay-token',
    polling: true,
    transport: {
      request: async (path) => {
        paths.push(path);
        if (failNext) {
          failNext = false;
          return { status: 502, body: 'relay unavailable' };
        }
        if (path.includes('/timeline')) {
          return { status: 200, body: JSON.stringify({ events: timelineEvents }) };
        }
        return { status: 200, body: JSON.stringify({ running: true }) };
      },
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    paths.length = 0;
    timelineEvents = [];
    failNext = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches up from the last sequence and reports runtime state', async () => {
    const events: unknown[] = [];
    const states: boolean[] = [];
    timelineEvents = [{ sequence: 3, type: 'assistant' }];

    const unsubscribe = subscribeSessionByPolling(pollingConfig, 's1', {
      onEvent: (event) => events.push(event),
      onState: (running) => states.push(running),
      getInitialSequence: () => 2,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(paths[0]).toBe('/api/sessions/s1/timeline?direction=after&cursor=2&limit=200');
    expect(events).toEqual([{ sequence: 3, type: 'assistant' }]);
    expect(states).toEqual([true]);

    unsubscribe();
  });

  it('drops events that are not newer than the cursor', async () => {
    const events: unknown[] = [];
    timelineEvents = [{ sequence: 2, type: 'duplicate' }, { sequence: 4, type: 'fresh' }];

    const unsubscribe = subscribeSessionByPolling(pollingConfig, 's1', {
      onEvent: (event) => events.push(event),
      getInitialSequence: () => 2,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ sequence: 4, type: 'fresh' }]);

    unsubscribe();
  });

  it('signals reconnect once after the relay recovers', async () => {
    const reconnects: number[] = [];
    failNext = true;

    const unsubscribe = subscribeSessionByPolling(pollingConfig, 's1', {
      onEvent: () => {},
      onReconnect: () => reconnects.push(1),
      getInitialSequence: () => 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(reconnects).toEqual([]);

    await vi.advanceTimersByTimeAsync(2500);
    expect(reconnects).toEqual([1]);

    unsubscribe();
  });

  it('stops polling after unsubscribe', async () => {
    const unsubscribe = subscribeSessionByPolling(pollingConfig, 's1', {
      onEvent: () => {},
      getInitialSequence: () => 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstTick = paths.length;
    unsubscribe();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(paths.length).toBe(callsAfterFirstTick);
  });

  it('routes subscribeSession through polling when the transport cannot upgrade WS', async () => {
    const events: unknown[] = [];
    timelineEvents = [{ sequence: 5, type: 'assistant' }];

    const client = createDaemonClient(pollingConfig);
    const unsubscribe = client.subscribeSession('s1', {
      onEvent: (event) => events.push(event),
      getInitialSequence: () => 4,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ sequence: 5, type: 'assistant' }]);

    unsubscribe();
  });
});
