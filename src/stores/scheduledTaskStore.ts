import { create } from 'zustand';

import { daemonFacade } from '../lib/facades/daemon-facade';
import type { ScheduledTask, ScheduledTaskInput, TaskRun } from '../types/scheduledTask';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: Record<string, TaskRun[]>;
  isLoading: boolean;
  fetchTasks: () => Promise<void>;
  fetchRuns: (taskId: string) => Promise<void>;
  createTask: (input: ScheduledTaskInput) => Promise<ScheduledTask>;
  updateTask: (taskId: string, input: ScheduledTaskInput) => Promise<ScheduledTask>;
  deleteTask: (taskId: string) => Promise<void>;
  setEnabled: (taskId: string, enabled: boolean) => Promise<ScheduledTask>;
  runTaskNow: (taskId: string) => Promise<TaskRun>;
  deleteRun: (taskId: string, runId: string) => Promise<void>;
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set) => ({
  tasks: [],
  runs: {},
  isLoading: false,

  fetchTasks: async () => {
    set({ isLoading: true });
    try {
      const tasks = await daemonFacade.scheduledTasks.list();
      set({ tasks, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchRuns: async (taskId) => {
    const runs = await daemonFacade.scheduledTasks.listRuns(taskId);
    set((state) => ({
      runs: { ...state.runs, [taskId]: runs },
    }));
  },

  createTask: async (input) => {
    const task = await daemonFacade.scheduledTasks.create(input);
    set((state) => ({ tasks: [task, ...state.tasks] }));
    return task;
  },

  updateTask: async (taskId, input) => {
    const task = await daemonFacade.scheduledTasks.update(taskId, input);
    set((state) => ({
      tasks: state.tasks.map((entry) => entry.id === taskId ? task : entry),
    }));
    return task;
  },

  deleteTask: async (taskId) => {
    await daemonFacade.scheduledTasks.delete(taskId);
    set((state) => ({
      tasks: state.tasks.filter((entry) => entry.id !== taskId),
      runs: Object.fromEntries(
        Object.entries(state.runs).filter(([id]) => id !== taskId),
      ),
    }));
  },

  setEnabled: async (taskId, enabled) => {
    const task = await daemonFacade.scheduledTasks.setEnabled(taskId, enabled);
    set((state) => ({
      tasks: state.tasks.map((entry) => entry.id === taskId ? task : entry),
    }));
    return task;
  },

  runTaskNow: async (taskId) => {
    const run = await daemonFacade.scheduledTasks.runNow(taskId);
    const tasks = await daemonFacade.scheduledTasks.list();
    const runs = await daemonFacade.scheduledTasks.listRuns(taskId);
    set((state) => ({
      tasks,
      runs: { ...state.runs, [taskId]: runs },
    }));
    return run;
  },

  deleteRun: async (taskId, runId) => {
    await daemonFacade.scheduledTasks.deleteRun(runId);
    const tasks = await daemonFacade.scheduledTasks.list();
    const runs = await daemonFacade.scheduledTasks.listRuns(taskId);
    set((state) => ({
      tasks,
      runs: { ...state.runs, [taskId]: runs },
    }));
  },
}));
