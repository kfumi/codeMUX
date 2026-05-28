import { create } from 'zustand';
import { agentApi } from '../lib/tauri';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  SidecarReadyEvent,
  SidecarErrorEvent,
} from '../types/agent';

export type AgentMessage =
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'done' }
  | { kind: 'raw'; data: Record<string, unknown> };

interface AgentState {
  /** Events for each session */
  events: Record<string, AgentMessage[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** Error message if any */
  error: Record<string, string | null>;

  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string) => Promise<void>;
  /** Interrupt the current query */
  interrupt: () => Promise<void>;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
}

function parseAgentEvent(raw: string): AgentMessage {
  try {
    const data = JSON.parse(raw);
    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'sidecar_query_done':
        return { kind: 'done' };
      case 'assistant':
        return { kind: 'assistant', data };
      case 'user':
        return { kind: 'tool_result', data };
      case 'system':
        return { kind: 'system', data };
      case 'result':
        return { kind: 'result', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  isRunning: {},
  error: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string) => {
    set((state) => ({
      isRunning: { ...state.isRunning, [sessionId]: true },
      error: { ...state.error, [sessionId]: null },
      events: { ...state.events, [sessionId]: [] },
    }));

    try {
      await agentApi.startSession(sessionId, prompt, cwd, (raw: string) => {
        const event = parseAgentEvent(raw);
        set((state) => ({
          events: {
            ...state.events,
            [sessionId]: [...(state.events[sessionId] || []), event],
          },
        }));

        if (event.kind === 'done' || event.kind === 'error') {
          set((state) => ({
            isRunning: { ...state.isRunning, [sessionId]: false },
            error: event.kind === 'error'
              ? { ...state.error, [sessionId]: event.data.error }
              : state.error,
          }));
        }
      });
    } catch (err) {
      set((state) => ({
        isRunning: { ...state.isRunning, [sessionId]: false },
        error: { ...state.error, [sessionId]: String(err) },
      }));
    }
  },

  interrupt: async () => {
    await agentApi.interrupt();
  },

  clearEvents: (sessionId: string) => {
    set((state) => {
      const newEvents = { ...state.events };
      delete newEvents[sessionId];
      const newRunning = { ...state.isRunning };
      delete newRunning[sessionId];
      const newError = { ...state.error };
      delete newError[sessionId];
      return { events: newEvents, isRunning: newRunning, error: newError };
    });
  },
}));
