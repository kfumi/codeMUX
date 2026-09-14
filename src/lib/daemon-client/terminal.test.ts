// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import type { DaemonConnectionConfig } from './client';
import { createTerminalMethods, type TerminalEvent } from './terminal';

function stubWebSocket(): ReturnType<typeof vi.fn> {
  const ctor = vi.fn(function (this: unknown, _url: string) {
    const socket = {
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

    const terminalId = await methods.terminalStart('/proj', 80, 24, onEvent);
    expect(terminalId).toBe('t1');
    expect(socketCtor).toHaveBeenCalledTimes(1);
  });
});
