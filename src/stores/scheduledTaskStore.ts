import { create } from 'zustand';

import { scheduledTaskApi } from '../lib/tauri';
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
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set) => ({
  tasks: [],
  runs: {},
  isLoading: false,

  fetchTasks: async () => {
    set({ isLoading: true });
    try {
      const tasks = await scheduledTaskApi.list();
      set({ tasks, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchRuns: async (taskId) => {
    const runs = await scheduledTaskApi.listRuns(taskId);
    set((state) => ({
      runs: { ...state.runs, [taskId]: runs },
    }));
  },

  createTask: async (input) => {
    const task = await scheduledTaskApi.create(input);
    set((state) => ({ tasks: [task, ...state.tasks] }));
    return task;
  },

  updateTask: async (taskId, input) => {
    const task = await scheduledTaskApi.update(taskId, input);
    set((state) => ({
      tasks: state.tasks.map((entry) => entry.id === taskId ? task : entry),
    }));
    return task;
  },

  deleteTask: async (taskId) => {
    await scheduledTaskApi.delete(taskId);
    set((state) => ({
      tasks: state.tasks.filter((entry) => entry.id !== taskId),
      runs: Object.fromEntries(
        Object.entries(state.runs).filter(([id]) => id !== taskId),
      ),
    }));
  },

  setEnabled: async (taskId, enabled) => {
    const task = await scheduledTaskApi.setEnabled(taskId, enabled);
    set((state) => ({
      tasks: state.tasks.map((entry) => entry.id === taskId ? task : entry),
    }));
    return task;
  },
}));
