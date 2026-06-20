import { create } from 'zustand';
import type { AgentKind, Session, SessionMode } from '../types/session';
import { sessionApi, agentApi } from '../lib/tauri';
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
  fetchSessions: () => Promise<void>;
  fetchArchivedSessions: () => Promise<void>;
  createSession: CreateSessionAction;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  touchSession: (sessionId: string) => void;
}

type CreateSessionAction = {
  (title: string, mode?: SessionMode, projectId?: string): Promise<Session>;
  (title: string, agentKind: AgentKind, mode?: SessionMode, projectId?: string): Promise<Session>;
};

function resolveDefaultAgentKind(): AgentKind {
  return useSettingsStore.getState().config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
}

function normalizeCreateSessionArgs(
  title: string,
  agentKindOrMode?: AgentKind | SessionMode,
  modeOrProjectId?: SessionMode | string,
  projectId?: string,
): [string, AgentKind, SessionMode | undefined, string | undefined] {
  if (
    agentKindOrMode === 'claude_code' ||
    agentKindOrMode === 'codex' ||
    agentKindOrMode === 'gemini_cli' ||
    agentKindOrMode === 'opencode'
  ) {
    return [title, agentKindOrMode, modeOrProjectId as SessionMode | undefined, projectId];
  }

  const legacyMode = agentKindOrMode;
  return [title, resolveDefaultAgentKind(), legacyMode, modeOrProjectId as string | undefined];
}

function createSessionAction(
  set: (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void,
): CreateSessionAction {
  function createSession(title: string, mode?: SessionMode, projectId?: string): Promise<Session>;
  function createSession(title: string, agentKind: AgentKind, mode?: SessionMode, projectId?: string): Promise<Session>;
  async function createSession(
    title: string,
    agentKindOrMode?: AgentKind | SessionMode,
    modeOrProjectId?: SessionMode | string,
    projectId?: string,
  ): Promise<Session> {
    set({ isLoading: true, error: null });
    try {
      const [, agentKind, mode, resolvedProjectId] = normalizeCreateSessionArgs(
        title,
        agentKindOrMode,
        modeOrProjectId,
        projectId,
      );
      const session = await sessionApi.create(title, agentKind, mode, resolvedProjectId);
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

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  archivedSessions: [],
  activeSessionId: null,
  isLoading: false,
  isArchivedLoading: false,
  error: null,
  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await sessionApi.getAll();
      set({ sessions, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  fetchArchivedSessions: async () => {
    set({ isArchivedLoading: true, error: null });
    try {
      const archivedSessions = await sessionApi.getArchived();
      set({ archivedSessions, isArchivedLoading: false });
    } catch (error) {
      set({ error: String(error), isArchivedLoading: false });
    }
  },
  createSession: createSessionAction(set),
  deleteSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      // Clean up agent session files (best-effort, don't block on failure)
      try {
        await agentApi.shutdown(sessionId);
        await agentApi.deleteClaudeSessionFiles(sessionId);
        await agentApi.deleteCodexSessionFiles(sessionId);
        await agentApi.resetSession(sessionId);
      } catch {
        // Ignore cleanup errors — the session mapping may not exist
      }
      // Clear in-memory agent events
      useAgentStore.getState().clearEvents(sessionId);
      // Delete from database
      await sessionApi.delete(sessionId);
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
      await sessionApi.archive(sessionId);
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
      await sessionApi.unarchive(sessionId);
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
  setActiveSession: (sessionId: string | null) => {
    set({ activeSessionId: sessionId });
  },
  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      await sessionApi.updateTitle(sessionId, title);
      set((state) => ({
        sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, title } : s),
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  touchSession: (sessionId: string) => {
    const now = new Date().toISOString();
    set((state) => ({
      sessions: state.sessions
        .map((s) => s.id === sessionId ? { ...s, updated_at: now } : s)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    }));
    sessionApi.touch(sessionId).catch(() => {});
  },
}));
