import { create } from 'zustand';
import type { Project } from '../types/project';
import { projectApi, agentApi } from '../lib/tauri';
import { useSessionStore } from './sessionStore';
import { useAgentStore } from './agentStore';

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, path: string) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProjectId: null,
  isLoading: false,
  error: null,
  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await projectApi.getAll();
      set({ projects, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  createProject: async (name: string, path: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await projectApi.create(name, path);
      set((state) => ({
        projects: [project, ...state.projects],
        activeProjectId: project.id,
        isLoading: false,
      }));
      return project;
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },
  deleteProject: async (projectId: string) => {
    set({ isLoading: true, error: null });
    try {
      // Clean up Claude session files for all sessions in this project
      const sessions = useSessionStore.getState().sessions.filter((s) => s.project_id === projectId);
      for (const session of sessions) {
        try {
          await agentApi.deleteClaudeSessionFiles(session.id);
          await agentApi.resetSession(session.id);
        } catch {
          // Ignore cleanup errors
        }
        useAgentStore.getState().clearEvents(session.id);
      }

      await projectApi.delete(projectId);
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
        activeProjectId: state.activeProjectId === projectId ? null : state.activeProjectId,
        isLoading: false,
      }));
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  renameProject: async (projectId: string, name: string) => {
    try {
      await projectApi.rename(projectId, name);
      set((state) => ({
        projects: state.projects.map((p) => p.id === projectId ? { ...p, name } : p),
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  setActiveProject: (projectId: string | null) => {
    set({ activeProjectId: projectId });
  },
}));
