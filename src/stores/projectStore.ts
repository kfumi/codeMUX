import { create } from 'zustand';
import type { Project } from '../types/project';
import { projectApi, agentApi } from '../lib/tauri';
import { useSessionStore } from './sessionStore';
import { useAgentStore } from './agentStore';

const COLLAPSED_PROJECTS_KEY = 'codemux-collapsed-projects';

function loadCollapsedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Ignore storage errors
  }
}

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  isLoading: boolean;
  error: string | null;
  collapsedProjects: Set<string>;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, path: string) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => void;
  toggleProjectExpanded: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProjectId: null,
  isLoading: false,
  error: null,
  collapsedProjects: loadCollapsedProjects(),
  toggleProjectExpanded: (projectId: string) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedProjects);
      if (newCollapsed.has(projectId)) {
        newCollapsed.delete(projectId);
      } else {
        newCollapsed.add(projectId);
      }
      saveCollapsedProjects(newCollapsed);
      return { collapsedProjects: newCollapsed };
    });
  },
  setProjectExpanded: (projectId: string, expanded: boolean) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedProjects);
      if (expanded) {
        newCollapsed.delete(projectId);
      } else {
        newCollapsed.add(projectId);
      }
      saveCollapsedProjects(newCollapsed);
      return { collapsedProjects: newCollapsed };
    });
  },
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
      // Remove from collapsed list if somehow present (new projects should be expanded)
      set((state) => {
        const newCollapsed = new Set(state.collapsedProjects);
        newCollapsed.delete(project.id);
        saveCollapsedProjects(newCollapsed);
        return {
          projects: [project, ...state.projects],
          activeProjectId: project.id,
          collapsedProjects: newCollapsed,
          isLoading: false,
        };
      });
      return project;
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },
  deleteProject: async (projectId: string) => {
    set({ isLoading: true, error: null });
    try {
      // Clean up agent session files for all sessions in this project (including archived)
      const sessionState = useSessionStore.getState();
      const allSessions = [
        ...sessionState.sessions,
        ...sessionState.archivedSessions,
      ].filter((s) => s.project_id === projectId);
      for (const session of allSessions) {
        try {
          await agentApi.deleteClaudeSessionFiles(session.id);
          await agentApi.deleteCodexSessionFiles(session.id);
          await agentApi.resetSession(session.id);
        } catch {
          // Ignore cleanup errors
        }
        useAgentStore.getState().clearEvents(session.id);
      }

      await projectApi.delete(projectId);

      // 从本地状态中移除该项目下的已归档 session
      useSessionStore.setState((state) => ({
        archivedSessions: state.archivedSessions.filter((s) => s.project_id !== projectId),
      }));

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
