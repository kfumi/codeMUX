import { describe, expect, it, vi } from 'vitest';

import { RelayTunnelClient } from './client';
import { exportPublicKeyB64, generateKeyPair } from '../e2ee';
import type { CompanionConnectionEntry } from '../types';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe('RelayTunnelClient', () => {
  it('rejects when the relay closes before E2EE handshake completes', async () => {
    const connection: Extract<CompanionConnectionEntry, { type: 'relay' }> = {
      id: 'relay:desktop-1',
      type: 'relay',
      endpoint: 'relay.example.com:443',
      useTls: true,
      desktopPublicKeyB64: 'desktop-key',
    };
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);

    try {
      const client = new RelayTunnelClient(connection, 'desktop-1');
      const resultPromise = client.connect().then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const socket = FakeWebSocket.instances[0];
      socket.onopen?.();
      socket.onclose?.();

      const result = await Promise.race([
        resultPromise,
        new Promise<string>((resolve) => {
          globalThis.setTimeout(() => resolve('test-timeout'), 100);
        }),
      ]);

      expect(result).toBe('Relay connection closed before handshake');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows a cold start slower than 5s to finish the handshake', async () => {
    const desktopPublicKeyB64 = exportPublicKeyB64(generateKeyPair().publicKey);
    const connection: Extract<CompanionConnectionEntry, { type: 'relay' }> = {
      id: 'relay:desktop-1',
      type: 'relay',
      endpoint: 'relay.example.com:443',
      useTls: true,
      desktopPublicKeyB64,
    };
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();

    try {
      const client = new RelayTunnelClient(connection, 'desktop-1');
      const resultPromise = client.connect().then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const socket = FakeWebSocket.instances[0];
      socket.onopen?.();
      // 冷启动超过旧上限(5s),但仍在新的 20s 窗口内。
      vi.advanceTimersByTime(8_000);
      socket.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) });

      await expect(resultPromise).resolves.toBe('resolved');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
