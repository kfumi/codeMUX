import { listen } from '@tauri-apps/api/event';

import { createLogger } from './logger';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';

const logger = createLogger('scheduledTasksBridge');

interface ScheduledTasksChangedPayload {
  taskIds?: string[];
  reason?: string;
}

export function initScheduledTasksBridge() {
  void listen<ScheduledTasksChangedPayload>('scheduled-tasks-changed', (event) => {
    const taskIds = event.payload?.taskIds ?? [];
    void useScheduledTaskStore.getState().fetchTasks().catch((error) => {
      logger.warn('Failed to refresh scheduled tasks after scheduled-tasks-changed event', { taskIds }, error as Error);
    });
    for (const taskId of taskIds) {
      void useScheduledTaskStore.getState().fetchRuns(taskId).catch((error) => {
        logger.warn('Failed to refresh scheduled task runs after scheduled-tasks-changed event', { taskId }, error as Error);
      });
    }
  });
}
