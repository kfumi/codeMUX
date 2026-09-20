import { createLogger } from './logger';
import { desktopBridge } from './desktop-bridge';
import { useWorkTaskStore } from '@/stores/workTaskStore';

const logger = createLogger('workTasksBridge');

interface WorkTasksChangedPayload {
  taskIds?: string[];
  reason?: string;
}

/**
 * daemon → 桌面 UI 的 work-tasks-changed 订阅：经壳的桌面 UI 事件出口
 * （daemon 控制面 WS → main webContents.send）。浏览器形态无此桥，
 * 由看板面板内的轮询兜底。
 */
export function initWorkTasksBridge(): (() => void) | undefined {
  if (!desktopBridge) {
    logger.warn('desktop bridge unavailable; work-tasks-changed bridge disabled');
    return undefined;
  }
  return desktopBridge.onDesktopEvent('work-tasks-changed', (payload) => {
    const data = (payload ?? {}) as WorkTasksChangedPayload;
    void useWorkTaskStore.getState().fetchTasks().catch((error) => {
      logger.warn('Failed to refresh work tasks after work-tasks-changed event', { taskIds: data.taskIds ?? [] }, error as Error);
    });
  });
}
