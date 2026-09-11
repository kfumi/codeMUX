import { listen } from '@tauri-apps/api/event';

import { desktopBridge, isElectronDesktop, type DesktopDaemonLifecycleEvent } from './desktop-bridge';
import { createLogger } from './logger';
import { useDaemonStatusStore, type DaemonProblemStatus } from '@/stores/daemonStatusStore';

const logger = createLogger('daemonLifecycleBridge');

/** supervisor 通过 tauri emit / preload 转发的 daemon 生命周期事件载荷。 */
export interface DaemonLifecyclePayload {
  status?: string;
  error?: string;
  decision?: string;
}

/** daemon-lifecycle 事件 → 轻量 store 标记(导出以便单测)。 */
export function handleDaemonLifecycleEvent(payload: DaemonLifecyclePayload | undefined): void {
  const status = payload?.status;
  if (status === 'exited') {
    markProblem('daemon-exited');
  } else if (status === 'start-failed') {
    markProblem('start-failed', payload?.error ?? null);
  }
}

function markProblem(problem: DaemonProblemStatus, error: string | null = null): void {
  useDaemonStatusStore.getState().setProblem(problem, error);
}

/**
 * daemon-lifecycle 事件桥(工单 05 起按平台分流):
 * - Electron 壳:订阅 preload 转发的 main 进程 supervisor 事件;
 * - Tauri 壳:订阅 tauri emit(行为与工单 04 一致)。
 */
export function initDaemonLifecycleBridge(): void {
  if (isElectronDesktop() && desktopBridge) {
    const unsubscribe = desktopBridge.onDaemonLifecycle((payload: DesktopDaemonLifecycleEvent) => {
      logger.info('daemon-lifecycle', { ...payload });
      handleDaemonLifecycleEvent(payload);
    });
    // 壳生命周期与页面同寿;支持 HMR 场景下重复 init 时先解绑旧订阅。
    const previous = pendingUnsubscribe;
    if (previous) {
      previous();
    }
    pendingUnsubscribe = unsubscribe;
    return;
  }
  void listen<DaemonLifecyclePayload>('daemon-lifecycle', (event) => {
    logger.info('daemon-lifecycle', { ...event.payload });
    handleDaemonLifecycleEvent(event.payload);
  });
}

let pendingUnsubscribe: (() => void) | null = null;

/** 测试/HMR 后清理:解绑 Electron 分支的事件订阅。 */
export function resetDaemonLifecycleBridge(): void {
  pendingUnsubscribe?.();
  pendingUnsubscribe = null;
}
