import { create } from 'zustand';
import type { AgentKind, Session, SessionMode } from '../types/session';
import type { AgentPermissionConfig, AgentPlanMode } from '../lib/agentPermissions';
import { isValidWorkingPath } from '../lib/sessionCwd';
import { daemonFacade } from '../lib/facades/daemon-facade';
import { useAgentStore } from './agentStore';
import { useSettingsStore } from './settingsStore';
import { getDefaultAgentKind } from '../types/agentRegistry';

interface SessionState {
  sessions: Session[];
  archivedSessions: Session[];
  activeSessionId: string | null;
  isLoading: boolean;
  isArchivedLoading: boolean;
  error: string | null;
  /** Session IDs that have unread status (completed or errored since last viewed) */
  unreadSessions: Set<string>;
  fetchSessions: () => Promise<void>;
  fetchArchivedSessions: () => Promise<void>;
  createSession: CreateSessionAction;
  forkSession: (
    sessionId: string,
    forkEventId: string,
    forkProviderMessageId?: string,
    forkProviderTurnId?: string,
    forkProviderTurnOrdinal?: number,
  ) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
  setSessionReadOnly: (sessionId: string, readOnly: boolean) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  updateSessionModel: (sessionId: string, model: string) => void;
  updateSessionPermissions: (sessionId: string, permissionConfig?: AgentPermissionConfig, planMode?: AgentPlanMode) => Promise<void>;
  touchSession: (sessionId: string) => void;
  markSessionRead: (sessionId: string) => void;
  markSessionUnread: (sessionId: string) => void;
}

type CreateSessionAction = {
  (
    title: string,
    agentKindOrMode?: AgentKind | SessionMode,
    modeOrProjectId?: SessionMode | string,
    projectIdOrPermissionConfig?: string | AgentPermissionConfig,
  permissionConfigOrPlanMode?: AgentPermissionConfig | AgentPlanMode,
  planMode?: AgentPlanMode,
  model?: string,
): Promise<Session>;
};

function resolveDefaultAgentKind(): AgentKind {
  return useSettingsStore.getState().config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
}

function normalizeCreateSessionArgs(
  title: string,
  agentKindOrMode?: AgentKind | SessionMode,
  modeOrProjectId?: SessionMode | string,
  projectId?: string,
  permissionConfig?: AgentPermissionConfig,
  planMode?: AgentPlanMode,
): [string, AgentKind, SessionMode | undefined, string | undefined, AgentPermissionConfig | undefined, AgentPlanMode | undefined] {
  if (
    agentKindOrMode === 'claude_code' ||
    agentKindOrMode === 'codex' ||
    agentKindOrMode === 'gemini_cli' ||
    agentKindOrMode === 'opencode' ||
    agentKindOrMode === 'pi'
  ) {
    return [title, agentKindOrMode, modeOrProjectId as SessionMode | undefined, projectId, permissionConfig, planMode];
  }

  const legacyMode = agentKindOrMode;
  return [title, resolveDefaultAgentKind(), legacyMode, modeOrProjectId as string | undefined, permissionConfig, planMode];
}

function createSessionAction(
  set: (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void,
): CreateSessionAction {
  async function createSession(
    title: string,
    agentKindOrMode?: AgentKind | SessionMode,
    modeOrProjectId?: SessionMode | string,
    projectIdOrPermissionConfig?: string | AgentPermissionConfig,
    permissionConfigOrPlanMode?: AgentPermissionConfig | AgentPlanMode,
    planMode?: AgentPlanMode,
    model?: string,
  ): Promise<Session> {
    set({ isLoading: true, error: null });
    try {
      const projectId = typeof projectIdOrPermissionConfig === 'string' ? projectIdOrPermissionConfig : undefined;
      const permissionConfig = typeof projectIdOrPermissionConfig === 'object'
        ? projectIdOrPermissionConfig
        : typeof permissionConfigOrPlanMode === 'object'
          ? permissionConfigOrPlanMode
          : undefined;
      const resolvedInputPlanMode = typeof permissionConfigOrPlanMode === 'string'
        ? permissionConfigOrPlanMode
        : planMode;
      const [, agentKind, mode, resolvedProjectId, resolvedPermissionConfig, resolvedPlanMode] = normalizeCreateSessionArgs(
        title,
        agentKindOrMode,
        modeOrProjectId,
        projectId,
        permissionConfig,
        resolvedInputPlanMode,
      );
      const session = resolvedPermissionConfig || resolvedPlanMode
        ? await daemonFacade.createSession(title, agentKind, mode, resolvedProjectId, resolvedPermissionConfig, resolvedPlanMode, model)
        : model
          ? await daemonFacade.createSession(title, agentKind, mode, resolvedProjectId, undefined, undefined, model)
          : await daemonFacade.createSession(title, agentKind, mode, resolvedProjectId);
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        isLoading: false,
      }));
      return session;
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  }

  return createSession;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  archivedSessions: [],
  activeSessionId: null,
  isLoading: false,
  isArchivedLoading: false,
  error: null,
  unreadSessions: new Set<string>(),
  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const rememberedPaths = useAgentStore.getState().sessionWorkingPaths;
      const fetched = await daemonFacade.listSessions();
      const sessions = fetched.map((session) => {
        const remembered = rememberedPaths[session.id]?.trim();
        if (isValidWorkingPath(remembered) && remembered !== session.working_path) {
          return { ...session, working_path: remembered };
        }
        return session;
      });
      set({ sessions, isLoading: false });
      for (const session of sessions) {
        const remembered = rememberedPaths[session.id]?.trim();
        if (isValidWorkingPath(remembered) && remembered !== session.working_path) {
          useAgentStore.getState().setSessionWorkingPath(session.id, remembered);
        }
      }
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  fetchArchivedSessions: async () => {
    set({ isArchivedLoading: true, error: null });
    try {
      const archivedSessions = await daemonFacade.listArchivedSessions();
      set({ archivedSessions, isArchivedLoading: false });
    } catch (error) {
      set({ error: String(error), isArchivedLoading: false });
    }
  },
  createSession: createSessionAction(set),
  forkSession: async (
    sessionId,
    forkEventId,
    forkProviderMessageId,
    forkProviderTurnId,
    forkProviderTurnOrdinal,
  ) => {
    set({ isLoading: true, error: null });
    try {
      const sourceSession = get().sessions.find((entry) => entry.id === sessionId)
        ?? get().archivedSessions.find((entry) => entry.id === sessionId);
      const session = sourceSession?.agent_kind === 'codex'
        ? await daemonFacade.forkCodex(
          sessionId,
          forkEventId,
          forkProviderMessageId,
          forkProviderTurnId,
          forkProviderTurnOrdinal,
        )
        : sourceSession?.agent_kind === 'opencode'
          ? await daemonFacade.forkOpenCode(sessionId, forkEventId, forkProviderMessageId)
        : sourceSession?.agent_kind === 'pi'
          ? await daemonFacade.forkPi(sessionId, forkEventId, forkProviderMessageId)
        : await daemonFacade.forkClaude(sessionId, forkEventId, forkProviderMessageId);
      useAgentStore.getState().clearEvents(session.id);
      set((state) => ({
        sessions: [session, ...state.sessions.filter((entry) => entry.id !== session.id)],
        activeSessionId: session.id,
        isLoading: false,
      }));
      return session;
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },
  deleteSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const session = get().sessions.find((entry) => entry.id === sessionId)
        ?? get().archivedSessions.find((entry) => entry.id === sessionId);
      if (session?.origin !== 'imported' && !session?.is_read_only) {
        try {
          await daemonFacade.shutdownAgent(sessionId);
          await daemonFacade.resetAgentSession(sessionId);
        } catch {
          // Ignore cleanup errors — the sidecar may already be gone.
        }
      }
      useAgentStore.getState().clearEvents(sessionId);
      await daemonFacade.deleteSession(sessionId);
      set((state) => {
        const newSessions = state.sessions.filter((s) => s.id !== sessionId);
        const newArchivedSessions = state.archivedSessions.filter((s) => s.id !== sessionId);
        const newActiveId = state.activeSessionId === sessionId ? (newSessions[0]?.id ?? null) : state.activeSessionId;
        return {
          sessions: newSessions,
          archivedSessions: newArchivedSessions,
          activeSessionId: newActiveId,
          isLoading: false,
        };
      });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  archiveSession: async (sessionId: string) => {
    try {
      await daemonFacade.archiveViaDaemon(sessionId);
      set((state) => {
        const session = state.sessions.find((entry) => entry.id === sessionId);
        const remainingSessions = state.sessions.filter((entry) => entry.id !== sessionId);
        const nextArchivedSessions = session
          ? [{ ...session, is_archived: true }, ...state.archivedSessions.filter((entry) => entry.id !== sessionId)]
          : state.archivedSessions;
        const nextActiveId = state.activeSessionId === sessionId ? (remainingSessions[0]?.id ?? null) : state.activeSessionId;
        return {
          sessions: remainingSessions,
          archivedSessions: nextArchivedSessions,
          activeSessionId: nextActiveId,
        };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },
  unarchiveSession: async (sessionId: string) => {
    try {
      await daemonFacade.unarchiveViaDaemon(sessionId);
      set((state) => {
        const session = state.archivedSessions.find((entry) => entry.id === sessionId);
        if (!session) return state;
        const restored = { ...session, is_archived: false };
        const nextArchivedSessions = state.archivedSessions.filter((entry) => entry.id !== sessionId);
        const nextSessions = [restored, ...state.sessions.filter((entry) => entry.id !== sessionId)];
        return {
          sessions: nextSessions.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
          archivedSessions: nextArchivedSessions,
        };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },
  setSessionPinned: async (sessionId: string, pinned: boolean) => {
    try {
      await daemonFacade.patchSessionViaDaemon(sessionId, { pinned });
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, is_pinned: pinned } : session),
        archivedSessions: state.archivedSessions.map((session) => session.id === sessionId ? { ...session, is_pinned: pinned } : session),
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  setSessionReadOnly: async (sessionId: string, readOnly: boolean) => {
    try {
      await daemonFacade.patchSessionViaDaemon(sessionId, { readOnly });
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, is_read_only: readOnly } : session),
        archivedSessions: state.archivedSessions.map((session) => session.id === sessionId ? { ...session, is_read_only: readOnly } : session),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  setActiveSession: (sessionId: string | null) => {
    set((state) => {
      if (!sessionId) return { activeSessionId: null };
      const next = new Set(state.unreadSessions);
      next.delete(sessionId);
      return { activeSessionId: sessionId, unreadSessions: next };
    });
  },
  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      await daemonFacade.patchSessionViaDaemon(sessionId, { title });
      set((state) => ({
        sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, title } : s),
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  updateSessionModel: (sessionId: string, model: string) => {
    set((state) => ({
      sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, model } : s),
    }));
  },
  updateSessionPermissions: async (sessionId: string, permissionConfig?: AgentPermissionConfig, planMode?: AgentPlanMode) => {
    try {
      await daemonFacade.updatePermissions(sessionId, permissionConfig, planMode);
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId
          ? {
              ...session,
              permission_config: permissionConfig ? JSON.stringify(permissionConfig) : session.permission_config,
              plan_mode: planMode ?? session.plan_mode,
            }
          : session),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  touchSession: (sessionId: string) => {
    const now = new Date().toISOString();
    set((state) => ({
      sessions: state.sessions
        .map((s) => s.id === sessionId ? { ...s, updated_at: now } : s)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    }));
    daemonFacade.touchSession(sessionId).catch(() => {});
  },
  markSessionRead: (sessionId: string) => {
    set((state) => {
      if (!state.unreadSessions.has(sessionId)) return state;
      const next = new Set(state.unreadSessions);
      next.delete(sessionId);
      return { unreadSessions: next };
    });
  },
  markSessionUnread: (sessionId: string) => {
    set((state) => {
      if (state.activeSessionId === sessionId) return state;
      if (state.unreadSessions.has(sessionId)) return state;
      const next = new Set(state.unreadSessions);
      next.add(sessionId);
      return { unreadSessions: next };
    });
  },
}));
