import { listen } from '@tauri-apps/api/event';

import { createLogger } from './logger';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import { useSessionStore } from '@/stores/sessionStore';

const logger = createLogger('sessionsChangeBridge');

interface SessionsChangedPayload {
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  reason?: string;
}

export function initSessionsChangeBridge() {
  void listen<SessionsChangedPayload>('sessions-changed', (event) => {
    const sessionId = event.payload?.sessionId;
    const taskId = event.payload?.taskId;
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
  });
}
