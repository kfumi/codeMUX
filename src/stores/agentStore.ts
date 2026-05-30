import { create } from 'zustand';
import { agentApi } from '../lib/tauri';
import { useSessionStore } from './sessionStore';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  SidecarReadyEvent,
  SidecarErrorEvent,
} from '../types/agent';

export type AgentMessage =
  | { kind: 'user'; data: { content: string } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'api_retry'; data: { attempt: number; max_retries: number; retry_delay_ms: number; error_status: number; error: string } }
  | { kind: 'ask_user_question'; data: { tool_use_id: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> } }
  | { kind: 'done' }
  | { kind: 'raw'; data: Record<string, unknown> };

interface AgentState {
  /** Events for each session */
  events: Record<string, AgentMessage[]>;
  /** Timestamps (ms) for each event, recorded at arrival time */
  eventTimestamps: Record<string, number[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** Error message if any */
  error: Record<string, string | null>;
  /** Track which sessions have had their title updated */
  titledSessions: Record<string, boolean>;

  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string) => Promise<void>;
  /** Interrupt the current query */
  interrupt: () => Promise<void>;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
  /** Load historical messages for a session */
  loadSessionMessages: (sessionId: string) => Promise<void>;
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
        if (data.subtype === 'init') {
          return { kind: 'system', data };
        }
        if (data.subtype === 'api_retry') {
          return { kind: 'api_retry', data };
        }
        return { kind: 'raw', data };
      case 'result':
        return { kind: 'result', data };
      case 'ask_user_question':
        return { kind: 'ask_user_question', data };
      case 'sidecar_debug':
        return { kind: 'raw', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

function truncateTitle(text: string, maxLen = 30): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + '...';
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  eventTimestamps: {},
  isRunning: {},
  error: {},
  titledSessions: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string) => {
    // Auto-update session title on first message
    const state = get();
    if (!state.titledSessions[sessionId]) {
      const title = truncateTitle(prompt);
      if (title) {
        useSessionStore.getState().updateSessionTitle(sessionId, title);
      }
      set((s) => ({ titledSessions: { ...s.titledSessions, [sessionId]: true } }));
    }

    // 添加用户消息到事件列表
    const userMsg: AgentMessage = { kind: 'user', data: { content: prompt } };
    const userTs = Date.now();
    set((s) => ({
      events: {
        ...s.events,
        [sessionId]: [...(s.events[sessionId] || []), userMsg],
      },
      eventTimestamps: {
        ...s.eventTimestamps,
        [sessionId]: [...(s.eventTimestamps[sessionId] || []), userTs],
      },
      isRunning: { ...s.isRunning, [sessionId]: true },
      error: { ...s.error, [sessionId]: null },
    }));

    try {
      await agentApi.startSession(sessionId, prompt, cwd, (raw: string) => {
        const event = parseAgentEvent(raw);
        const now = Date.now();
        set((s) => ({
          events: {
            ...s.events,
            [sessionId]: [...(s.events[sessionId] || []), event],
          },
          eventTimestamps: {
            ...s.eventTimestamps,
            [sessionId]: [...(s.eventTimestamps[sessionId] || []), now],
          },
        }));

        if (event.kind === 'done' || event.kind === 'error' || (event.kind === 'result' && event.data?.is_error)) {
          set((s) => ({
            isRunning: { ...s.isRunning, [sessionId]: false },
            error: event.kind === 'error'
              ? { ...s.error, [sessionId]: event.data.error }
              : s.error,
          }));

          // Persist agent events to database
          const currentEvents = get().events[sessionId];
          if (currentEvents && currentEvents.length > 0) {
            const eventsToSave = currentEvents.filter((e) => e.kind !== 'done');
            agentApi.saveEvents(sessionId, JSON.stringify(eventsToSave)).catch((err) => {
              console.error('Failed to save agent events:', err);
            });
          }
        }
      }, apiKey, baseUrl, model);
    } catch (err) {
      set((s) => ({
        isRunning: { ...s.isRunning, [sessionId]: false },
        error: { ...s.error, [sessionId]: String(err) },
      }));
    }
  },

  interrupt: async () => {
    await agentApi.interrupt();
    // Sidecar doesn't emit an event on abort, so reset running state directly,
    // add an interrupt marker, and persist events
    set((s) => {
      const isRunning = { ...s.isRunning };
      const events = { ...s.events };
      for (const sid of Object.keys(isRunning)) {
        if (isRunning[sid]) {
          isRunning[sid] = false;
          // Add interrupt marker message
          const interruptMsg: AgentMessage = {
            kind: 'user',
            data: { content: '[Request interrupted by user for tool use]' },
          };
          events[sid] = [...(events[sid] || []), interruptMsg];
          // Save events for interrupted sessions
          if (events[sid].length > 0) {
            const eventsToSave = events[sid].filter((e) => e.kind !== 'done');
            agentApi.saveEvents(sid, JSON.stringify(eventsToSave)).catch((err) => {
              console.error('Failed to save agent events on interrupt:', err);
            });
          }
        }
      }
      return { isRunning, events };
    });
  },

  clearEvents: (sessionId: string) => {
    set((state) => {
      const newEvents = { ...state.events };
      delete newEvents[sessionId];
      const newTimestamps = { ...state.eventTimestamps };
      delete newTimestamps[sessionId];
      const newRunning = { ...state.isRunning };
      delete newRunning[sessionId];
      const newError = { ...state.error };
      delete newError[sessionId];
      return { events: newEvents, eventTimestamps: newTimestamps, isRunning: newRunning, error: newError };
    });
  },

  loadSessionMessages: async (sessionId: string) => {
    // Don't reload if we already have events for this session
    const existing = get().events[sessionId];
    if (existing && existing.length > 0) return;

    try {
      const eventsJson = await agentApi.getEvents(sessionId);
      if (eventsJson) {
        const events: AgentMessage[] = JSON.parse(eventsJson);
        // Generate placeholder timestamps to keep arrays aligned (historical events have no real timing)
        const timestamps = new Array(events.length).fill(0);
        set((state) => ({
          events: { ...state.events, [sessionId]: events },
          eventTimestamps: { ...state.eventTimestamps, [sessionId]: timestamps },
        }));
      }
    } catch (err) {
      console.error('Failed to load agent events:', err);
    }
  },
}));
