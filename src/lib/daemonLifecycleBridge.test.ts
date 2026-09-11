import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({
  bridge: undefined as { onDaemonLifecycle: ReturnType<typeof vi.fn> } | undefined,
}));

vi.mock('./desktop-bridge', async () => {
  const actual = await vi.importActual<typeof import('./desktop-bridge')>('./desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.bridge;
    },
  };
});

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
    bridgeState.bridge = { onDaemonLifecycle: vi.fn(() => () => {}) };
    resetDaemonLifecycleBridge();
    useDaemonStatusStore.getState().clearProblem();
  });

  it('subscribes via the Electron preload bridge (唯一事件源,工单 09 终态)', () => {
    initDaemonLifecycleBridge();
    expect(bridgeState.bridge?.onDaemonLifecycle).toHaveBeenCalledWith(expect.any(Function));

    // 壳桥收到的 exited 事件同样置位 store(与原 Tauri emit 行为一致)。
    bridgeState.bridge!.onDaemonLifecycle.mock.calls[0][0]({ status: 'exited' });
    expect(useDaemonStatusStore.getState().problem).toBe('daemon-exited');
  });

  it('electron branch start-failed carries the error summary', () => {
    initDaemonLifecycleBridge();
    bridgeState.bridge!.onDaemonLifecycle.mock.calls[0][0]({ status: 'start-failed', error: 'spawn 失败' });
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBe('start-failed');
    expect(state.error).toBe('spawn 失败');
  });

  it('bridge 缺失(纯 Web)时不订阅且不净丢:无事件源即禁用,store 保持干净', () => {
    bridgeState.bridge = undefined;
    initDaemonLifecycleBridge();
    expect(useDaemonStatusStore.getState().problem).toBeNull();
  });

  it('re-init 解绑旧订阅(HMR 重复 init 不泄漏)', () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    bridgeState.bridge = { onDaemonLifecycle: vi.fn(() => firstUnsubscribe) };
    initDaemonLifecycleBridge();
    bridgeState.bridge = { onDaemonLifecycle: vi.fn(() => secondUnsubscribe) };
    initDaemonLifecycleBridge();
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(secondUnsubscribe).not.toHaveBeenCalled();

    resetDaemonLifecycleBridge();
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
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
