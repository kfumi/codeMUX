import { createLogger } from './logger';
import { desktopBridge } from './desktop-bridge';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import { useSessionStore } from '@/stores/sessionStore';

const logger = createLogger('sessionsChangeBridge');

interface SessionsChangedPayload {
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  reason?: string;
}

function handleSessionsChanged(payload: SessionsChangedPayload): void {
  const sessionId = payload?.sessionId;
  const taskId = payload?.taskId;
  void useSessionStore.getState().fetchSessions().then(() => {
    if (sessionId) {
      useSessionStore.getState().markSessionUnread(sessionId);
    }
  }).catch((error) => {
    logger.warn('Failed to refresh sessions after sessions-changed event', { sessionId }, error as Error);
  });
  if (taskId) {
    void useScheduledTaskStore.getState().fetchRuns(taskId).catch((error) => {
      logger.warn('Failed to refresh scheduled task runs after sessions-changed event', { taskId }, error as Error);
    });
    void useScheduledTaskStore.getState().fetchTasks().catch((error) => {
      logger.warn('Failed to refresh scheduled tasks after sessions-changed event', { taskId }, error as Error);
    });
  }
}

/**
 * daemon → 桌面 UI 的 sessions-changed 订阅:经壳的桌面 UI 事件出口
 * (daemon 控制面 WS → main webContents.send,工单 09);载荷与原
 * Tauri emit 同名同形。
 */
export function initSessionsChangeBridge(): (() => void) | undefined {
  if (!desktopBridge) {
    logger.warn('desktop bridge unavailable; sessions-changed bridge disabled');
    return undefined;
  }
  return desktopBridge.onDesktopEvent('sessions-changed', (payload) => {
    handleSessionsChanged((payload ?? {}) as SessionsChangedPayload);
  });
}
