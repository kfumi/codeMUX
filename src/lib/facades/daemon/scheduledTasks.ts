import type { ScheduledTask, ScheduledTaskInput, TaskRun } from '../../../types/scheduledTask';
import { ensureDaemonClient } from './lifecycle';

/** 定时任务。 */
export const scheduledTasks = {
  list: async () => (await ensureDaemonClient()).scheduledList() as Promise<ScheduledTask[]>,
  get: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledGet(taskId) as Promise<ScheduledTask | null>,
  create: async (input: ScheduledTaskInput) =>
    (await ensureDaemonClient()).scheduledCreate(input) as Promise<ScheduledTask>,
  update: async (taskId: string, input: ScheduledTaskInput) =>
    (await ensureDaemonClient()).scheduledUpdate(taskId, input) as Promise<ScheduledTask>,
  delete: async (taskId: string) => {
    await (await ensureDaemonClient()).scheduledDelete(taskId);
  },
  setEnabled: async (taskId: string, enabled: boolean) =>
    (await ensureDaemonClient()).scheduledSetEnabled(taskId, enabled) as Promise<ScheduledTask>,
  listRuns: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledListRuns(taskId) as Promise<TaskRun[]>,
  runNow: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledRunNow(taskId) as Promise<TaskRun>,
  deleteRun: async (runId: string) => {
    await (await ensureDaemonClient()).scheduledDeleteRun(runId);
  },
  getTimezone: async () => (await ensureDaemonClient()).scheduledGetTimezone(),
};

export type ScheduledTasksDomain = typeof scheduledTasks;
