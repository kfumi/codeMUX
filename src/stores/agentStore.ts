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
  TodoItem,
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
  /** Current todos per session (extracted from TodoWrite / Task tools) */
  todos: Record<string, TodoItem[]>;

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

/**
 * Extract the current todo list from a stream of agent events.
 * Handles TodoWrite (full list replacement), TaskCreate/TaskUpdate (incremental),
 * and infers status from tool execution flow when TodoWrite doesn't update statuses.
 */
function extractTodosFromEvents(events: AgentMessage[]): TodoItem[] {
  let todos: TodoItem[] = [];
  const taskMap = new Map<string, TodoItem>();
  let hasExplicitUpdates = false; // true if any TodoWrite with non-pending status was seen
  // Track which task index each tool call is associated with (tool_use_id → task index)
  const toolToTask = new Map<string, number>();
  // Auto-incrementing task ID counter (1, 2, 3...) matching SDK convention
  let nextTaskId = 1;

  for (const evt of events) {
    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];

      for (const block of blocks) {
        if (block?.type !== 'tool_use' || !block.name) continue;

        // TodoWrite: replaces the entire todo list
        if (block.name === 'TodoWrite') {
          const inputTodos = (block.input as any)?.todos;
          if (Array.isArray(inputTodos)) {
            const newTodos = inputTodos.map((t: any) => ({
              content: String(t.content || ''),
              status: (['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending') as TodoItem['status'],
              activeForm: t.activeForm || undefined,
            }));
            // Check if this TodoWrite has any non-pending status
            if (newTodos.some((t) => t.status !== 'pending')) {
              hasExplicitUpdates = true;
            }
            todos = newTodos;
            // Rebuild taskMap with sequential IDs so subsequent TaskUpdate can find them
            taskMap.clear();
            newTodos.forEach((t, i) => {
              taskMap.set(String(i + 1), t);
            });
          }
          continue; // skip inference for TodoWrite
        }

        // TaskCreate: adds a single task
        if (block.name === 'TaskCreate') {
          const input = block.input as any;
          // Use SDK-provided id if available, otherwise auto-increment (1, 2, 3...)
          const taskId = String(input?.id || input?.task_id || nextTaskId++);
          const item: TodoItem = {
            content: String(input?.subject || input?.description || ''),
            status: 'pending',
            activeForm: input?.activeForm || undefined,
          };
          taskMap.set(taskId, item);
          todos.push(item);
          continue; // skip inference for TaskCreate
        }

        // TaskUpdate: updates an existing task by taskId
        if (block.name === 'TaskUpdate') {
          const input = block.input as any;
          const taskId = input?.taskId;
          if (taskId && taskMap.has(taskId)) {
            const item = taskMap.get(taskId)!;
            if (input.status) {
              hasExplicitUpdates = true;
              item.status = (['pending', 'in_progress', 'completed', 'deleted'].includes(input.status)
                ? input.status === 'deleted' ? 'completed' : input.status
                : 'pending') as TodoItem['status'];
            }
            if (input.subject) item.content = String(input.subject);
            if (input.activeForm) item.activeForm = String(input.activeForm);
          }
          continue; // skip inference for TaskUpdate
        }

        // Infer progress from tool calls: mark first pending task as in_progress
        // and record which task this tool call is associated with.
        // Skip task-management and read-only query tools — they don't represent work.
        const skipInferenceTools = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
        if (!hasExplicitUpdates && todos.length > 0 && !skipInferenceTools.includes(block.name)) {
          const firstPending = todos.find((t) => t.status === 'pending');
          if (firstPending) {
            firstPending.status = 'in_progress';
            if (block.id) {
              toolToTask.set(block.id, todos.indexOf(firstPending));
            }
          }
        }
      }
    }

    // Infer progress from tool results: only complete the task this tool was associated with
    if (!hasExplicitUpdates && evt.kind === 'tool_result' && todos.length > 0) {
      const data: any = evt.data;
      const rawContent = data?.message?.content;
      if (Array.isArray(rawContent)) {
        for (const r of rawContent) {
          if (r?.type === 'tool_result' && r.tool_use_id && toolToTask.has(r.tool_use_id)) {
            const taskIdx = toolToTask.get(r.tool_use_id)!;
            if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
              todos[taskIdx].status = 'completed';
            }
            toolToTask.delete(r.tool_use_id);
          }
        }
      }
      // Fallback: also check tool_use_result and parent_tool_use_id
      if (data?.tool_use_result?.tool_use_id && toolToTask.has(data.tool_use_result.tool_use_id)) {
        const taskIdx = toolToTask.get(data.tool_use_result.tool_use_id)!;
        if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
          todos[taskIdx].status = 'completed';
        }
        toolToTask.delete(data.tool_use_result.tool_use_id);
      }
      if (data?.parent_tool_use_id && toolToTask.has(data.parent_tool_use_id)) {
        const taskIdx = toolToTask.get(data.parent_tool_use_id)!;
        if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
          todos[taskIdx].status = 'completed';
        }
        toolToTask.delete(data.parent_tool_use_id);
      }
    }
  }

  return todos;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  eventTimestamps: {},
  isRunning: {},
  error: {},
  titledSessions: {},
  todos: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string) => {
    // Check if another session is already running
    const currentIsRunning = get().isRunning;
    for (const [sid, running] of Object.entries(currentIsRunning)) {
      if (running && sid !== sessionId) {
        throw new Error('请等待当前任务完成后再发起新对话');
      }
    }

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
        set((s) => {
          const prev = s.events[sessionId] || [];
          const newEvents = [...prev, event];
          return {
            events: {
              ...s.events,
              [sessionId]: newEvents,
            },
            eventTimestamps: {
              ...s.eventTimestamps,
              [sessionId]: [...(s.eventTimestamps[sessionId] || []), now],
            },
            todos: {
              ...s.todos,
              [sessionId]: extractTodosFromEvents(newEvents),
            },
          };
        });

        if (event.kind === 'done' || event.kind === 'error' || (event.kind === 'result' && event.data?.is_error)) {
          set((s) => ({
            isRunning: { ...s.isRunning, [sessionId]: false },
            error: event.kind === 'error'
              ? { ...s.error, [sessionId]: event.data.error }
              : s.error,
          }));

          // Persist agent events to database (with timestamps)
          const currentEvents = get().events[sessionId];
          const currentTimestamps = get().eventTimestamps[sessionId];
          if (currentEvents && currentEvents.length > 0) {
            const eventsToSave = currentEvents.filter((e) => e.kind !== 'done');
            // Rebuild matching timestamps for filtered events
            const timestampsToSave = currentEvents
              .map((e, i) => (e.kind !== 'done' ? currentTimestamps?.[i] ?? 0 : null))
              .filter((t): t is number => t !== null);
            const payload = JSON.stringify({ events: eventsToSave, timestamps: timestampsToSave });
            agentApi.saveEvents(sessionId, payload).catch((err) => {
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
      const eventTimestamps = { ...s.eventTimestamps };
      for (const sid of Object.keys(isRunning)) {
        if (isRunning[sid]) {
          isRunning[sid] = false;
          // Add interrupt marker message
          const interruptMsg: AgentMessage = {
            kind: 'user',
            data: { content: '[Request interrupted by user for tool use]' },
          };
          events[sid] = [...(events[sid] || []), interruptMsg];
          eventTimestamps[sid] = [...(eventTimestamps[sid] || []), Date.now()];
          // Save events for interrupted sessions
          if (events[sid].length > 0) {
            const eventsToSave = events[sid].filter((e) => e.kind !== 'done');
            const tsArr = eventTimestamps[sid] || [];
            const timestampsToSave = events[sid]
              .map((e, i) => (e.kind !== 'done' ? tsArr[i] ?? 0 : null))
              .filter((t): t is number => t !== null);
            const payload = JSON.stringify({ events: eventsToSave, timestamps: timestampsToSave });
            agentApi.saveEvents(sid, payload).catch((err) => {
              console.error('Failed to save agent events on interrupt:', err);
            });
          }
        }
      }
      return { isRunning, events, eventTimestamps };
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
      const newTodos = { ...state.todos };
      delete newTodos[sessionId];
      return { events: newEvents, eventTimestamps: newTimestamps, isRunning: newRunning, error: newError, todos: newTodos };
    });
  },

  loadSessionMessages: async (sessionId: string) => {
    // Don't reload if we already have events for this session
    const existing = get().events[sessionId];
    if (existing && existing.length > 0) return;

    try {
      const eventsJson = await agentApi.getEvents(sessionId);
      if (eventsJson) {
        const parsed = JSON.parse(eventsJson);
        // Support both old format (plain array) and new format (object with timestamps)
        let events: AgentMessage[];
        let timestamps: number[];
        if (Array.isArray(parsed)) {
          // Old format: plain array of events
          events = parsed;
          timestamps = new Array(events.length).fill(0);
        } else {
          // New format: { events, timestamps }
          events = parsed.events || [];
          timestamps = parsed.timestamps || new Array(events.length).fill(0);
        }
        set((state) => ({
          events: { ...state.events, [sessionId]: events },
          eventTimestamps: { ...state.eventTimestamps, [sessionId]: timestamps },
          todos: { ...state.todos, [sessionId]: extractTodosFromEvents(events) },
        }));
      }
    } catch (err) {
      console.error('Failed to load agent events:', err);
    }
  },
}));
