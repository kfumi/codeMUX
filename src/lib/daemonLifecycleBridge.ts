import { listen } from '@tauri-apps/api/event';

import { createLogger } from './logger';
import { useDaemonStatusStore, type DaemonProblemStatus } from '@/stores/daemonStatusStore';

const logger = createLogger('daemonLifecycleBridge');

/** supervisor 通过 tauri emit 的 daemon 生命周期事件载荷。 */
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

export function initDaemonLifecycleBridge(): void {
  void listen<DaemonLifecyclePayload>('daemon-lifecycle', (event) => {
    logger.info('daemon-lifecycle', { ...event.payload });
    handleDaemonLifecycleEvent(event.payload);
  });
}
