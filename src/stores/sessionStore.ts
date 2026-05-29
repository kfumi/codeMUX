import { create } from 'zustand';
import type { Session } from '../types/session';
import { sessionApi } from '../lib/tauri';

interface SessionState {
  sessions: Session[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  createSession: (title: string, mode?: string, projectId?: string) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
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
  createSession: async (title: string, mode?: string, projectId?: string) => {
    set({ isLoading: true, error: null });
    try {
      const session = await sessionApi.create(title, mode, projectId);
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
  },
  deleteSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      await sessionApi.delete(sessionId);
      set((state) => {
        const newSessions = state.sessions.filter((s) => s.id !== sessionId);
        const newActiveId = state.activeSessionId === sessionId ? (newSessions[0]?.id ?? null) : state.activeSessionId;
        return { sessions: newSessions, activeSessionId: newActiveId, isLoading: false };
      });
    } catch (error) {
      set({ error: String(error), isLoading: false });
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
}));
