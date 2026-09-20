import { create } from 'zustand';

import { daemonFacade } from '../lib/facades/daemon-facade';
import type { WorkTask, WorkTaskInput, WorkTaskPatch } from '../types/workTask';

/** 需要用户处理的状态：等待输入 / 待审查 / 失败。 */
const ATTENTION_STATUSES = ['awaiting_input', 'review', 'failed'] as const;

export function selectAttentionCount(tasks: WorkTask[]): number {
  return tasks.filter(
    (task) => !task.archivedAt
      && (ATTENTION_STATUSES as readonly string[]).includes(task.status),
  ).length;
}

function replaceTask(tasks: WorkTask[], task: WorkTask): WorkTask[] {
  return tasks.map((entry) => entry.id === task.id ? task : entry);
}

interface WorkTaskState {
  tasks: WorkTask[];
  isLoading: boolean;
  fetchTasks: () => Promise<void>;
  createTask: (input: WorkTaskInput) => Promise<WorkTask>;
  updateTask: (taskId: string, patch: WorkTaskPatch) => Promise<WorkTask>;
  deleteTask: (taskId: string) => Promise<void>;
  archiveTask: (taskId: string) => Promise<WorkTask>;
  unarchiveTask: (taskId: string) => Promise<WorkTask>;
  /** 归档当前所有未归档的 done 任务，完成后整体刷新。 */
  archiveAllDone: () => Promise<void>;
  /** 待办列内拖拽排序：乐观更新 sortOrder，再提交 /reorder，失败回源。 */
  reorder: (projectId: string, ids: string[]) => Promise<void>;
  startTask: (taskId: string) => Promise<WorkTask>;
  cancelTask: (taskId: string) => Promise<WorkTask>;
  retryTask: (taskId: string) => Promise<WorkTask>;
  restartTask: (taskId: string) => Promise<WorkTask>;
  mergeTask: (taskId: string, message?: string) => Promise<WorkTask>;
  completeTask: (taskId: string) => Promise<WorkTask>;
}

export const useWorkTaskStore = create<WorkTaskState>((set, get) => ({
  tasks: [],
  isLoading: false,

  fetchTasks: async () => {
    set({ isLoading: true });
    try {
      const tasks = await daemonFacade.workTasks.list();
      set({ tasks, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  createTask: async (input) => {
    const task = await daemonFacade.workTasks.create(input);
    set((state) => ({ tasks: [task, ...state.tasks] }));
    return task;
  },

  updateTask: async (taskId, patch) => {
    const task = await daemonFacade.workTasks.update(taskId, patch);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  deleteTask: async (taskId) => {
    await daemonFacade.workTasks.delete(taskId);
    set((state) => ({
      tasks: state.tasks.filter((entry) => entry.id !== taskId),
    }));
  },

  archiveTask: async (taskId) => {
    const task = await daemonFacade.workTasks.archive(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  unarchiveTask: async (taskId) => {
    const task = await daemonFacade.workTasks.unarchive(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  archiveAllDone: async () => {
    const doneTasks = get().tasks.filter(
      (task) => task.status === 'done' && !task.archivedAt,
    );
    const results = await Promise.allSettled(
      doneTasks.map((task) => daemonFacade.workTasks.archive(task.id)),
    );
    const failed = results.some((result) => result.status === 'rejected');
    await get().fetchTasks();
    if (failed) {
      throw new Error('部分任务归档失败，请重试');
    }
  },

  reorder: async (projectId, ids) => {
    const idOrder = new Map(ids.map((id, index) => [id, index]));
    const previous = get().tasks;
    set({
      tasks: previous.map((task) => {
        if (task.projectId !== projectId) return task;
        const nextOrder = idOrder.get(task.id);
        return nextOrder === undefined
          ? task
          : { ...task, sortOrder: nextOrder };
      }),
    });
    try {
      await daemonFacade.workTasks.reorder(projectId, ids);
    } catch (error) {
      // 回滚到快照，再拉一次兜底
      set({ tasks: previous });
      await get().fetchTasks();
      throw error;
    }
  },

  startTask: async (taskId) => {
    // 乐观更新：先把本地行置 queued（卡片立即移入进行中列），失败回滚 + 兜底刷新。
    const previous = get().tasks;
    set({
      tasks: previous.map((task) =>
        task.id === taskId ? { ...task, status: 'queued' as const } : task,
      ),
    });
    try {
      const task = await daemonFacade.workTasks.start(taskId);
      set((state) => ({ tasks: replaceTask(state.tasks, task) }));
      return task;
    } catch (error) {
      set({ tasks: previous });
      await get().fetchTasks();
      throw error;
    }
  },

  cancelTask: async (taskId) => {
    const task = await daemonFacade.workTasks.cancel(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  retryTask: async (taskId) => {
    const task = await daemonFacade.workTasks.retry(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  restartTask: async (taskId) => {
    const task = await daemonFacade.workTasks.restart(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  mergeTask: async (taskId, message) => {
    const task = await daemonFacade.workTasks.merge(taskId, message);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },

  completeTask: async (taskId) => {
    const task = await daemonFacade.workTasks.complete(taskId);
    set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    return task;
  },
}));
