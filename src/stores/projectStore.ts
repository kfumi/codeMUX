import { create } from 'zustand';
import { daemonFacade } from '../lib/facades/daemon-facade';
import type { Project } from '../types/project';
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
  /** 见 sessionStore 的同名字段：区分「还没拉到」与「确实没有项目」。 */
  hasLoadedOnce: boolean;
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
  hasLoadedOnce: false,
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
      const projects = await daemonFacade.listProjects();
      set({ projects, isLoading: false, hasLoadedOnce: true });
    } catch (error) {
      // 失败同样算「加载结束」,避免侧边栏骨架屏永远停住。
      set({ error: String(error), isLoading: false, hasLoadedOnce: true });
    }
  },
  createProject: async (name: string, path: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await daemonFacade.createProject(name, path);
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
      // 只清理内存中的事件数据，保留 agent 底层文件（原生 CLI 仍可访问历史）
      const sessionState = useSessionStore.getState();
      const allSessions = [
        ...sessionState.sessions,
        ...sessionState.archivedSessions,
      ].filter((s) => s.project_id === projectId);
      for (const session of allSessions) {
        useAgentStore.getState().clearEvents(session.id);
      }

      // 删除 SQLite 中的项目及其下所有会话记录
      await daemonFacade.deleteProject(projectId);

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
      await daemonFacade.renameProject(projectId, name);
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
