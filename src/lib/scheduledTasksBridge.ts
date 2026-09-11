import { createLogger } from './logger';
import { desktopBridge } from './desktop-bridge';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';

const logger = createLogger('scheduledTasksBridge');

interface ScheduledTasksChangedPayload {
  taskIds?: string[];
  reason?: string;
}

function handleScheduledTasksChanged(payload: ScheduledTasksChangedPayload): void {
  const taskIds = payload?.taskIds ?? [];
  void useScheduledTaskStore.getState().fetchTasks().catch((error) => {
    logger.warn('Failed to refresh scheduled tasks after scheduled-tasks-changed event', { taskIds }, error as Error);
  });
  for (const taskId of taskIds) {
    void useScheduledTaskStore.getState().fetchRuns(taskId).catch((error) => {
      logger.warn('Failed to refresh scheduled task runs after scheduled-tasks-changed event', { taskId }, error as Error);
    });
  }
}

/**
 * daemon → 桌面 UI 的 scheduled-tasks-changed 订阅:经壳的桌面 UI 事件
 * 出口(daemon 控制面 WS → main webContents.send,工单 09);载荷与原
 * Tauri emit 同名同形。
 */
export function initScheduledTasksBridge(): (() => void) | undefined {
  if (!desktopBridge) {
    logger.warn('desktop bridge unavailable; scheduled-tasks-changed bridge disabled');
    return undefined;
  }
  return desktopBridge.onDesktopEvent('scheduled-tasks-changed', (payload) => {
    handleScheduledTasksChanged((payload ?? {}) as ScheduledTasksChangedPayload);
  });
}
