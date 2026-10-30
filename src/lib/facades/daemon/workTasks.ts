import type {
  WorkTask,
  WorkTaskEvent,
  WorkTaskInput,
  WorkTaskPatch,
} from '../../../types/workTask';
import { ensureDaemonClient } from './lifecycle';

/** 待办看板任务。 */
export const workTasks = {
  list: async () => (await ensureDaemonClient()).workTaskList() as Promise<WorkTask[]>,
  get: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskGet(taskId) as Promise<WorkTask | null>,
  create: async (input: WorkTaskInput) =>
    (await ensureDaemonClient()).workTaskCreate(input) as Promise<WorkTask>,
  update: async (taskId: string, patch: WorkTaskPatch) =>
    (await ensureDaemonClient()).workTaskUpdate(taskId, patch) as Promise<WorkTask>,
  delete: async (taskId: string) => {
    await (await ensureDaemonClient()).workTaskDelete(taskId);
  },
  archive: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskArchive(taskId) as Promise<WorkTask>,
  unarchive: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskUnarchive(taskId) as Promise<WorkTask>,
  reorder: async (projectId: string, ids: string[]) => {
    await (await ensureDaemonClient()).workTaskReorder(projectId, ids);
  },
  start: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskStart(taskId) as Promise<WorkTask>,
  cancel: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskCancel(taskId) as Promise<WorkTask>,
  retry: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskRetry(taskId) as Promise<WorkTask>,
  restart: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskRestart(taskId) as Promise<WorkTask>,
  merge: async (taskId: string, message?: string) =>
    (await ensureDaemonClient()).workTaskMerge(taskId, message) as Promise<WorkTask>,
  complete: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskComplete(taskId) as Promise<WorkTask>,
  /** 任务时间线（GET /work-tasks/{id}/events）。 */
  listEvents: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskListEvents(taskId) as Promise<WorkTaskEvent[]>,
};

export type WorkTasksDomain = typeof workTasks;
