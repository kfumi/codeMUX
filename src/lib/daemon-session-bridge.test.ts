import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeSessionMock = vi.hoisted(() => vi.fn());

vi.mock('./facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(async () => ({
    subscribeSession: subscribeSessionMock,
  })),
}));

import {
  getLastEventSequence,
  registerDaemonSessionHandler,
  resetDaemonSessionBridge,
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
});
