import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitRepositoryState } from './gitTypes';

const mocks = vi.hoisted(() => {
  const gitApi = {
    getRepositoryState: vi.fn(),
    getStatusChanges: vi.fn(),
  };

  type AgentState = { isRunning: Record<string, boolean> };
  const agentListeners = new Set<(state: AgentState) => void>();
  let agentState: AgentState = { isRunning: {} };
  const emit = () => {
    agentListeners.forEach((listener) => listener(agentState));
  };
  const agentStore = {
    getState: () => agentState,
    subscribe: (listener: (state: AgentState) => void) => {
      agentListeners.add(listener);
      return () => {
        agentListeners.delete(listener);
      };
    },
    // 与真实 store 一致：按会话键增量写入，键不会被删除。
    setRunning: (patch: Record<string, boolean>) => {
      agentState = { isRunning: { ...agentState.isRunning, ...patch } };
      emit();
    },
    resetRunning: () => {
      agentState = { isRunning: {} };
      emit();
    },
    clearListeners: () => agentListeners.clear(),
  };

  let sessionState: { sessions: Array<{ id: string; project_id: string | null }>; archivedSessions: Array<{ id: string; project_id: string | null }> } = {
    sessions: [],
    archivedSessions: [],
  };
  const sessionStore = {
    getState: () => sessionState,
    setSessions: (sessions: typeof sessionState.sessions, archivedSessions: typeof sessionState.archivedSessions = []) => {
      sessionState = { sessions, archivedSessions };
    },
  };

  let projectState: {
    projects: Array<{
      id: string;
      roots: Array<{ path: string; position: number; isPrimary: boolean }>;
    }>;
  } = { projects: [] };
  const projectStore = {
    getState: () => projectState,
    setProjects: (projects: typeof projectState.projects) => {
      projectState = { projects };
    },
  };

  return { gitApi, agentStore, sessionStore, projectStore };
});

vi.mock('./facades/daemon-facade', () => ({ daemonFacade: { git: mocks.gitApi } }));
vi.mock('../stores/agentStore', () => ({ useAgentStore: mocks.agentStore }));
vi.mock('../stores/sessionStore', () => ({ useSessionStore: mocks.sessionStore }));
vi.mock('../stores/projectStore', () => ({ useProjectStore: mocks.projectStore }));

import { useGitEnvironmentStore } from '../stores/gitEnvironmentStore';
import { initGitEnvironmentTurnSync, resolveProjectPathForSession } from './gitEnvironmentSync';

function repoState(branch = 'main'): GitRepositoryState {
  return {
    currentBranch: branch,
    branches: [{ name: branch, current: true }],
    detached: false,
    hasUncommittedChanges: true,
    aheadCount: 0,
    hasUnpushedCommits: false,
    upstreamBranch: null,
    upstreamRef: null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('gitEnvironmentSync', () => {
  beforeEach(() => {
    useGitEnvironmentStore.getState().reset();
    vi.clearAllMocks();
    mocks.gitApi.getRepositoryState.mockResolvedValue(repoState());
    mocks.gitApi.getStatusChanges.mockResolvedValue([]);
    mocks.agentStore.clearListeners();
    mocks.agentStore.resetRunning();
    mocks.sessionStore.setSessions([{ id: 's1', project_id: 'p1' }]);
    mocks.projectStore.setProjects([
      { id: 'p1', roots: [{ path: 'D:/app', position: 0, isPrimary: true }] },
    ]);
  });

  it('解析会话所属项目路径；未知会话或项目返回 null', () => {
    expect(resolveProjectPathForSession('s1')).toBe('D:/app');
    expect(resolveProjectPathForSession('missing')).toBeNull();

    mocks.sessionStore.setSessions([{ id: 's2', project_id: null }]);
    expect(resolveProjectPathForSession('s2')).toBeNull();
  });

  it('回合结束（true→false）刷新对应项目的缓存', async () => {
    await useGitEnvironmentStore.getState().ensure('D:/app');
    expect(mocks.gitApi.getRepositoryState).toHaveBeenCalledTimes(1);

    const unsubscribe = initGitEnvironmentTurnSync();
    mocks.agentStore.setRunning({ s1: true });
    mocks.agentStore.setRunning({ s1: false });
    await flush();

    expect(mocks.gitApi.getRepositoryState).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('项目没有缓存时不因回合结束取数', async () => {
    const unsubscribe = initGitEnvironmentTurnSync();
    mocks.agentStore.setRunning({ s1: true });
    mocks.agentStore.setRunning({ s1: false });
    await flush();

    expect(mocks.gitApi.getRepositoryState).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('非回合结束的 isRunning 变化不触发刷新', async () => {
    await useGitEnvironmentStore.getState().ensure('D:/app');
    const unsubscribe = initGitEnvironmentTurnSync();

    mocks.agentStore.setRunning({ s1: true }); // 开始
    mocks.agentStore.setRunning({ s1: true });
    mocks.agentStore.setRunning({ s2: false }); // 无关会话
    await flush();

    expect(mocks.gitApi.getRepositoryState).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('取消订阅后不再刷新', async () => {
    await useGitEnvironmentStore.getState().ensure('D:/app');
    const unsubscribe = initGitEnvironmentTurnSync();
    unsubscribe();

    mocks.agentStore.setRunning({ s1: true });
    mocks.agentStore.setRunning({ s1: false });
    await flush();

    expect(mocks.gitApi.getRepositoryState).toHaveBeenCalledTimes(1);
  });
});
