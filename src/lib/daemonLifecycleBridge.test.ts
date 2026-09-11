import { beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.hoisted(() => vi.fn());
const onDaemonLifecycleMock = vi.hoisted(() => vi.fn());
const isElectronDesktopMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('./desktop-bridge', () => ({
  desktopBridge: { onDaemonLifecycle: onDaemonLifecycleMock },
  isElectronDesktop: isElectronDesktopMock,
}));

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import {
  handleDaemonLifecycleEvent,
  initDaemonLifecycleBridge,
  resetDaemonLifecycleBridge,
} from './daemonLifecycleBridge';
import { useDaemonStatusStore } from '../stores/daemonStatusStore';

describe('daemonLifecycleBridge', () => {
  beforeEach(() => {
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    onDaemonLifecycleMock.mockReset();
    onDaemonLifecycleMock.mockReturnValue(() => {});
    isElectronDesktopMock.mockReset();
    isElectronDesktopMock.mockReturnValue(false);
    resetDaemonLifecycleBridge();
    useDaemonStatusStore.getState().clearProblem();
  });

  it('registers a daemon-lifecycle listener', () => {
    initDaemonLifecycleBridge();
    expect(listenMock).toHaveBeenCalledWith('daemon-lifecycle', expect.any(Function));
  });

  it('subscribes via the Electron preload bridge instead of tauri listen', () => {
    isElectronDesktopMock.mockReturnValue(true);
    initDaemonLifecycleBridge();
    expect(onDaemonLifecycleMock).toHaveBeenCalledWith(expect.any(Function));
    expect(listenMock).not.toHaveBeenCalled();

    // Electron 分支收到的 exited 事件同样置位 store(与 Tauri 行为一致)。
    onDaemonLifecycleMock.mock.calls[0][0]({ status: 'exited' });
    expect(useDaemonStatusStore.getState().problem).toBe('daemon-exited');
  });

  it('electron branch start-failed carries the error summary', () => {
    isElectronDesktopMock.mockReturnValue(true);
    initDaemonLifecycleBridge();
    onDaemonLifecycleMock.mock.calls[0][0]({ status: 'start-failed', error: 'spawn 失败' });
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBe('start-failed');
    expect(state.error).toBe('spawn 失败');
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
