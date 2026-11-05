// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import type { DaemonConnectionConfig } from './client';
import { createTerminalMethods, type TerminalEvent } from './terminal';

interface StubSocket {
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  OPEN: number;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function stubWebSocket(): ReturnType<typeof vi.fn> {
  const ctor = vi.fn(function (this: unknown, _url: string) {
    const socket: StubSocket = {
      onopen: null as ((event?: unknown) => void) | null,
      onerror: null as ((event?: unknown) => void) | null,
      onmessage: null as ((event?: unknown) => void) | null,
      onclose: null as ((event?: unknown) => void) | null,
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    // jsdom 没有 socket 服务:构造后立刻视为已连接,connectSocket 的
    // promise 才能resolve;断言只关心「是否在正确通道上开过 WS」。
    queueMicrotask(() => socket.onopen?.());
    return socket;
  });
  vi.stubGlobal('WebSocket', ctor);
  return ctor;
}

const fetch = vi.fn(<T>(_config: DaemonConnectionConfig, _path: string, _init?: RequestInit) =>
  Promise.resolve({ terminalId: 't1' } as unknown as T));

describe('createTerminalMethods (channel guards)', () => {
  it('rejects start with a readable error on a polling (relay) channel instead of opening a broken WS', async () => {
    const socketCtor = stubWebSocket();
    const pollingConfig: DaemonConnectionConfig = {
      baseUrl: 'relay://relay.example:443',
      token: 'tok',
      polling: true,
    };
    const methods = createTerminalMethods(pollingConfig, fetch, async () => pollingConfig);
    const onEvent = vi.fn() as (event: TerminalEvent) => void;

    // 守卫在 connectSocket 里,REST 建终端的调用会发生,但不该真的去开 WS。
    await expect(methods.terminalStart('/proj', 80, 24, onEvent)).rejects.toThrow(
      /WebSocket 直连/,
    );
    expect(socketCtor).not.toHaveBeenCalled();
  });

  it('rejects start when the transport override carries the channel', async () => {
    const socketCtor = stubWebSocket();
    const relayConfig: DaemonConnectionConfig = {
      baseUrl: 'relay://relay.example:443',
      token: 'tok',
      transport: { request: vi.fn(async () => ({ status: 200, body: '{}' })) },
    };
    const methods = createTerminalMethods(relayConfig, fetch, async () => relayConfig);
    const onEvent = vi.fn() as (event: TerminalEvent) => void;

    await expect(methods.terminalStart('/proj', 80, 24, onEvent)).rejects.toThrow(
      /WebSocket 直连/,
    );
    expect(socketCtor).not.toHaveBeenCalled();
  });

  it('still works over a direct http channel', async () => {
    const socketCtor = stubWebSocket();
    const directConfig: DaemonConnectionConfig = {
      baseUrl: 'http://127.0.0.1:9240',
      token: 'tok',
    };
    const methods = createTerminalMethods(directConfig, fetch, async () => directConfig);
    const onEvent = vi.fn() as (event: TerminalEvent) => void;

    const result = await methods.terminalStart('/proj', 80, 24, onEvent);
    expect(result.terminalId).toBe('t1');
    expect(socketCtor).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous socket on re-attach instead of feeding both channels', async () => {
    const socketCtor = stubWebSocket();
    const directConfig: DaemonConnectionConfig = {
      baseUrl: 'http://127.0.0.1:9240',
      token: 'tok',
    };
    const methods = createTerminalMethods(directConfig, fetch, async () => directConfig);
    const first = vi.fn() as (event: TerminalEvent) => void;
    const second = vi.fn() as (event: TerminalEvent) => void;

    await methods.terminalAttach('t1', 80, 24, first);
    await methods.terminalAttach('t1', 80, 24, second);

    const firstSocket = socketCtor.mock.instances[0] as unknown as StubSocket;
    const secondSocket = socketCtor.mock.instances[1] as unknown as StubSocket;

    // 旧通道必须被关掉并摘掉回调：否则 daemon 的每段输出会被两条 WS 各投一次。
    expect(firstSocket.close).toHaveBeenCalled();
    expect(firstSocket.onmessage).toBeNull();

    secondSocket.onmessage?.({
      data: JSON.stringify({ type: 'output', terminalId: 't1', data: 'hi' }),
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
