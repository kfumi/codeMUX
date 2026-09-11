import { beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import { handleDaemonLifecycleEvent, initDaemonLifecycleBridge } from './daemonLifecycleBridge';
import { useDaemonStatusStore } from '../stores/daemonStatusStore';

describe('daemonLifecycleBridge', () => {
  beforeEach(() => {
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    useDaemonStatusStore.getState().clearProblem();
  });

  it('registers a daemon-lifecycle listener', () => {
    initDaemonLifecycleBridge();
    expect(listenMock).toHaveBeenCalledWith('daemon-lifecycle', expect.any(Function));
  });

  it('marks daemon-exited on exited status', () => {
    handleDaemonLifecycleEvent({ status: 'exited' });
    expect(useDaemonStatusStore.getState().problem).toBe('daemon-exited');
    expect(useDaemonStatusStore.getState().error).toBeNull();
  });

  it('marks start-failed with the error summary', () => {
    handleDaemonLifecycleEvent({ status: 'start-failed', error: 'daemon 提前退出' });
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBe('start-failed');
    expect(state.error).toBe('daemon 提前退出');
  });

  it('marks start-failed without an error summary', () => {
    handleDaemonLifecycleEvent({ status: 'start-failed' });
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBe('start-failed');
    expect(state.error).toBeNull();
  });

  it('ignores unrelated lifecycle statuses (started etc.)', () => {
    handleDaemonLifecycleEvent({ status: 'started', decision: 'attached' });
    expect(useDaemonStatusStore.getState().problem).toBeNull();
  });
});
