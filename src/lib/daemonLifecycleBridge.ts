import { desktopBridge, type DesktopDaemonLifecycleEvent } from './desktop-bridge';
import { createLogger } from './logger';
import { useDaemonStatusStore, type DaemonProblemStatus } from '@/stores/daemonStatusStore';

const logger = createLogger('daemonLifecycleBridge');

/** supervisor 经 preload 转发的 daemon 生命周期事件载荷。 */
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
 * daemon-lifecycle 事件桥(工单 09 终态):订阅 preload 转发的 main 进程
 * supervisor 事件。桥缺失(纯 Web)时仅告警 —— 无壳即无 supervisor 事件源。
 */
export function initDaemonLifecycleBridge(): void {
  if (!desktopBridge) {
    logger.warn('desktop bridge unavailable; daemon-lifecycle bridge disabled');
    return;
  }
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
}

let pendingUnsubscribe: (() => void) | null = null;

/** 测试/HMR 后清理:解绑 Electron 分支的事件订阅。 */
export function resetDaemonLifecycleBridge(): void {
  pendingUnsubscribe?.();
  pendingUnsubscribe = null;
}
