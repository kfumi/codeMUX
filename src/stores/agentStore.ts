import { create } from 'zustand';
import { agentApi, fileApi } from '../lib/tauri';
import { createLogger, serializeError } from '../lib/logger';
import {
  isClaudeSubagentEvent,
  isClaudeCompactSummaryRawEvent,
  isClaudeCompactSummaryText,
  isAgentInjectedUserMessage,
  isTerminalAgentEvent,
  mapPersistedClaudeMessage,
  normalizeClaudeUserEvent,
  parseSdkUserMessage,
  shouldProcessTerminalEvent,
  shouldSuppressLiveEventWhileStopped,
} from './agentEventParsing';
import { useSessionStore } from './sessionStore';
import { normalizeFilePath, usePreviewStore } from './previewStore';
import { useSettingsStore } from './settingsStore';
import { countDiffLines } from '../lib/diffStats';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  SidecarReadyEvent,
  SidecarErrorEvent,
  TodoItem,
  ChangedFile,
} from '../types/agent';
import type { ReasoningEffort } from '../types/session';
import type { AgentInputPayload, UserAttachmentPreview } from '../types/agentInput';
import { inferModelSupportsVision, markModelVisionUnsupported } from '../lib/modelVisionCapabilities';

export type AgentMessage =
  | { kind: 'user'; data: { content: string; attachments?: UserAttachmentPreview[] } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'stream_status'; data: { message: string; is_reconnecting: boolean; mode_blocked?: ModeBlockedDiagnostic | null } }
  | { kind: 'api_retry'; data: { attempt: number; max_retries: number; retry_delay_ms: number; error_status: number; error: string } }
  | { kind: 'ask_user_question'; data: { tool_use_id: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> } }
  | { kind: 'compact'; data: { compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number }; subtype: string; type: string } }
  | { kind: 'mcp_status'; data: { servers: Record<string, string>; status?: string } }
  | { kind: 'proxy_status'; data: { running: boolean; port: number | null; upstreamBaseUrl: string | null } }
  | { kind: 'todo_list'; data: { todos: TodoItem[] } }
  | { kind: 'streaming'; data: { event: Record<string, unknown>; session_id?: string } }
  | { kind: 'streaming_batch'; data: { events: Record<string, unknown>[]; session_id?: string } }
  | { kind: 'file_snapshot'; data: { file_path: string; original_content: string; is_new: boolean; tool_use_id: string } }
  | { kind: 'done' }
  | { kind: 'raw'; data: Record<string, unknown> };

type ModeBlockedDiagnostic = {
  blocked_method?: string;
  effective_mode?: string;
  reason_code?: string;
  reason?: string;
  suggestion?: string;
  request_id?: string | null;
};

interface AgentState {
  /** Events for each session */
  events: Record<string, AgentMessage[]>;
  /** Timestamps (ms) for each event, recorded at arrival time */
  eventTimestamps: Record<string, number[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** When each running query started (ms epoch) — for elapsed timer */
  queryStartTime: Record<string, number>;
  /** Error message if any */
  error: Record<string, string | null>;
  /** Latest MCP runtime status for each session */
  mcpRuntimeStatus: Record<string, string | null>;
  /** Current todos per session (extracted from TodoWrite / Task tools) */
  todos: Record<string, TodoItem[]>;
  /** Accumulated streaming thinking text per session (from stream_event deltas) */
  streamingThinking: Record<string, string>;
  /** Accumulated streaming text per session (from stream_event text deltas) */
  streamingText: Record<string, string>;
  /** Thinking durations computed from streaming events (key: session_id, value: ms) */
  streamingThinkingDurations: Record<string, number[]>;
  /** Sessions that were force-stopped (interrupt) — suppress streaming UI immediately */
  forceStopped: Record<string, boolean>;
  streamingToolInputs: Record<string, Record<string, string>>;
  streamingToolMeta: Record<string, Record<string, { name: string; index: number }>>;
  streamingToolIndexMap: Record<string, Record<number, string>>;
  streamedToolUseIds: Record<string, Set<string>>;
  changedFiles: Record<string, ChangedFile[]>;
  fileOriginals: Record<string, Record<string, FileOriginalSnapshot>>;
  acknowledgedFiles: Record<string, Set<string>>;

  /** Sub-agent events keyed by "sessionId:agentId" */
  subAgentEvents: Record<string, AgentMessage[]>;
  /** Sub-agent loading state keyed by "sessionId:agentId" */
  subAgentLoading: Record<string, boolean>;
  /** Claude Agent tool call ID -> sub-agent ID index, keyed by sessionId */
  subAgentIndex: Record<string, Record<string, string>>;
  /** Claude sub-agent index loading state keyed by sessionId */
  subAgentIndexLoading: Record<string, boolean>;

  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string, reasoningEffort?: ReasoningEffort, codexNeedsProxy?: boolean, displayContent?: string, inputPayload?: AgentInputPayload) => Promise<void>;
  /** Interrupt the current query for a specific session */
  interrupt: (sessionId: string) => Promise<void>;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
  /** Load historical messages for a session */
  loadSessionMessages: (sessionId: string) => Promise<void>;
  /** Load sub-agent events for a specific agent */
  loadSubagentEvents: (sessionId: string, agentId: string) => Promise<void>;
  /** Clear changed files for a session */
  clearChangedFiles: (sessionId: string) => void;
}

type StreamingBuffer = {
  thinking: string;
  text: string;
};

const STREAMING_FLUSH_THROTTLE_MS = 100;
const logger = createLogger('agentStore');
const pendingStreamingBuffers = new Map<string, StreamingBuffer>();
const pendingStreamingFlushHandles = new Map<string, ReturnType<typeof setTimeout>>();
const sessionsWithLiveTextStream = new Set<string>();
const pendingSubagentIndexRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSubagentIndexRetryAttempts = new Map<string, number>();
const liveSubagentParentKeys = new Map<string, string>();
const SUBAGENT_INDEX_RETRY_DELAY_MS = 500;
const SUBAGENT_INDEX_MAX_RETRIES = 12;
/** Per-session thinking start timestamps (set on content_block_start, cleared on content_block_stop) */
const pendingThinkingStartTimes = new Map<string, number>();
const streamingTelemetry = new Map<string, { deltas: number; flushes: number; uiUpdates: number }>();

function scheduleStreamingFlush(callback: () => void) {
  return setTimeout(callback, STREAMING_FLUSH_THROTTLE_MS);
}

function cancelScheduledStreamingFlush(handle: ReturnType<typeof setTimeout>) {
  clearTimeout(handle);
}

function recordStreamingTelemetry(sessionId: string, key: keyof { deltas: number; flushes: number; uiUpdates: number }) {
  const stats = streamingTelemetry.get(sessionId) ?? { deltas: 0, flushes: 0, uiUpdates: 0 };
  stats[key] += 1;
  streamingTelemetry.set(sessionId, stats);
}

function logStreamingTelemetry(sessionId: string, reason: string) {
  const stats = streamingTelemetry.get(sessionId);
  if (!stats || stats.deltas === 0) return;
  logger.debug('Streaming flush telemetry', { sessionId, reason, ...stats });
}

function applyStreamingBuffer(
  sessionId: string,
  buffer: StreamingBuffer,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  if (!buffer.thinking && !buffer.text) {
    return;
  }

  recordStreamingTelemetry(sessionId, 'uiUpdates');
  set((state) => {
    const updates: Partial<AgentState> = {};

    if (buffer.thinking) {
      updates.streamingThinking = {
        ...state.streamingThinking,
        [sessionId]: (state.streamingThinking[sessionId] || '') + buffer.thinking,
      };
    }

    if (buffer.text) {
      updates.streamingText = {
        ...state.streamingText,
        [sessionId]: (state.streamingText[sessionId] || '') + buffer.text,
      };
    }

    return updates;
  });
}

function flushPendingStreaming(
  sessionId: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  const handle = pendingStreamingFlushHandles.get(sessionId);
  if (handle !== undefined) {
    cancelScheduledStreamingFlush(handle);
    pendingStreamingFlushHandles.delete(sessionId);
  }

  const buffer = pendingStreamingBuffers.get(sessionId);
  if (!buffer) {
    return;
  }

  pendingStreamingBuffers.delete(sessionId);
  recordStreamingTelemetry(sessionId, 'flushes');
  applyStreamingBuffer(sessionId, buffer, set);
}

function clearPendingStreaming(sessionId: string) {
  const handle = pendingStreamingFlushHandles.get(sessionId);
  if (handle !== undefined) {
    cancelScheduledStreamingFlush(handle);
    pendingStreamingFlushHandles.delete(sessionId);
  }

  pendingStreamingBuffers.delete(sessionId);
  sessionsWithLiveTextStream.delete(sessionId);
  logStreamingTelemetry(sessionId, 'clear');
  streamingTelemetry.delete(sessionId);
}

function clearStreamingTextField(
  sessionId: string,
  field: 'streamingThinking' | 'streamingText',
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  get: () => AgentState,
) {
  if (!get()[field][sessionId]) {
    return;
  }

  set((state) => {
    return {
      [field]: { ...state[field], [sessionId]: '' },
    } as Partial<AgentState>;
  });
}

function isReconnectingStreamStatus(event: AgentMessage): boolean {
  return event.kind === 'stream_status' && event.data.is_reconnecting;
}

function queueStreamingDelta(
  sessionId: string,
  key: keyof StreamingBuffer,
  chunk: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  if (!chunk) {
    return;
  }

  recordStreamingTelemetry(sessionId, 'deltas');
  if (key === 'text') {
    sessionsWithLiveTextStream.add(sessionId);
  }
  const buffer = pendingStreamingBuffers.get(sessionId) ?? { thinking: '', text: '' };
  buffer[key] += chunk;
  pendingStreamingBuffers.set(sessionId, buffer);

  if (pendingStreamingFlushHandles.has(sessionId)) {
    return;
  }

  const handle = scheduleStreamingFlush(() => {
    pendingStreamingFlushHandles.delete(sessionId);
    const pending = pendingStreamingBuffers.get(sessionId);
    if (!pending) {
      return;
    }

    pendingStreamingBuffers.delete(sessionId);
    recordStreamingTelemetry(sessionId, 'flushes');
    applyStreamingBuffer(sessionId, pending, set);
  });

  pendingStreamingFlushHandles.set(sessionId, handle);
}

// ---------------------------------------------------------------------------
// Simulated streaming: when the SDK delivers text all at once (e.g. reasoning
// models that only emit item.completed for the final text), feed it to
// streamingText in chunks so the UI renders token-by-token instead of
// appearing all at once.
// ---------------------------------------------------------------------------

const SIM_CHARS_PER_TICK = 24;
const SIM_TICK_MS = 24;

type SimulatedStreamEntry = {
  event: AgentMessage;
  remaining: string;
  timer: number;
};

const pendingSimulatedStreams = new Map<string, SimulatedStreamEntry>();
const pendingStreamingToolInputBuffers = new Map<string, Map<string, string>>();

function appendPendingStreamingToolInput(sessionId: string, toolId: string, chunk: string) {
  if (!chunk) {
    return;
  }

  const sessionBuffers = pendingStreamingToolInputBuffers.get(sessionId) ?? new Map<string, string>();
  sessionBuffers.set(toolId, (sessionBuffers.get(toolId) ?? '') + chunk);
  pendingStreamingToolInputBuffers.set(sessionId, sessionBuffers);
}

function readPendingStreamingToolInput(sessionId: string, toolId: string, state: AgentState): string {
  const committedInput = state.streamingToolInputs[sessionId]?.[toolId] ?? '';
  const pendingInput = pendingStreamingToolInputBuffers.get(sessionId)?.get(toolId) ?? '';
  return `${committedInput}${pendingInput}`;
}

function clearPendingStreamingToolInputs(sessionId: string) {
  pendingStreamingToolInputBuffers.delete(sessionId);
}

function replaceToolUseBlocksInEvents(
  events: AgentMessage[],
  replacementsById: Map<string, unknown>,
): { events: AgentMessage[]; changed: boolean } {
  if (replacementsById.size === 0) {
    return { events, changed: false };
  }

  let changed = false;
  const nextEvents = events.map((event) => {
    if (event.kind !== 'assistant') {
      return event;
    }

    let contentChanged = false;
    const nextContent = event.data.message.content.map((block) => {
      if (
        block?.type === 'tool_use'
        && typeof block.id === 'string'
        && replacementsById.has(block.id)
      ) {
        contentChanged = true;
        changed = true;
        return replacementsById.get(block.id) as typeof block;
      }

      return block;
    });

    if (!contentChanged) {
      return event;
    }

    return {
      ...event,
      data: {
        ...event.data,
        message: {
          ...event.data.message,
          content: nextContent,
        },
      },
    };
  });

  return { events: nextEvents, changed };
}

function isAgentToolName(toolName: unknown): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'subagent';
}

function applySubagentIndexToEvents(
  events: AgentMessage[],
  index: Record<string, string>,
): { events: AgentMessage[]; changed: boolean } {
  if (Object.keys(index).length === 0) {
    return { events, changed: false };
  }

  let changed = false;
  const nextEvents = events.map((event) => {
    if (event.kind !== 'assistant') {
      return event;
    }

    let contentChanged = false;
    const nextContent = event.data.message.content.map((block) => {
      if (
        block?.type === 'tool_use'
        && isAgentToolName(block.name)
        && typeof block.id === 'string'
        && index[block.id]
        && (block.agentId !== index[block.id] || block.subAgentKey !== block.id)
      ) {
        changed = true;
        contentChanged = true;
        return { ...block, agentId: index[block.id], subAgentKey: block.id };
      }

      return block;
    });

    if (!contentChanged) {
      return event;
    }

    return {
      ...event,
      data: {
        ...event.data,
        message: {
          ...event.data.message,
          content: nextContent,
        },
      },
    };
  });

  return { events: nextEvents, changed };
}

function migrateSubagentLiveCaches(
  subAgentEvents: Record<string, AgentMessage[]>,
  sessionId: string,
  index: Record<string, string>,
): { subAgentEvents: Record<string, AgentMessage[]>; changed: boolean } {
  let nextEvents = subAgentEvents;
  let changed = false;

  for (const [toolUseId, agentId] of Object.entries(index)) {
    const liveKey = `${sessionId}:${toolUseId}`;
    const historyKey = `${sessionId}:${agentId}`;
    const liveEvents = nextEvents[liveKey];
    if (!liveEvents || liveKey === historyKey) {
      continue;
    }

    const historyEvents = nextEvents[historyKey] ?? [];
    const knownIds = new Set(historyEvents.map((event) => getEventStableId(event)).filter(Boolean));
    const merged = [
      ...historyEvents,
      ...liveEvents.filter((event) => {
        const id = getEventStableId(event);
        return !id || !knownIds.has(id);
      }),
    ];

    const { [liveKey]: _removed, ...rest } = nextEvents;
    nextEvents = { ...rest, [historyKey]: merged };
    changed = true;
  }

  return { subAgentEvents: nextEvents, changed };
}

function getEventStableId(event: AgentMessage): string | undefined {
  const data = 'data' in event ? event.data as Record<string, unknown> : undefined;
  return typeof data?.uuid === 'string' ? data.uuid : undefined;
}

function hasAgentToolCall(event: AgentMessage): boolean {
  if (event.kind !== 'assistant') {
    return false;
  }

  return event.data.message.content.some((block) =>
    block?.type === 'tool_use'
    && isAgentToolName(block.name)
    && typeof block.id === 'string',
  );
}

function hasAgentToolUseId(events: AgentMessage[], toolUseId: string): boolean {
  return events.some((event) =>
    event.kind === 'assistant'
    && event.data.message.content.some((block) =>
      block?.type === 'tool_use'
      && block.id === toolUseId
      && isAgentToolName(block.name),
    ),
  );
}

function hasUnpatchedAgentToolCall(events: AgentMessage[]): boolean {
  return events.some((event) =>
    event.kind === 'assistant'
    && event.data.message.content.some((block) =>
      block?.type === 'tool_use'
      && isAgentToolName(block.name)
      && typeof block.id === 'string'
      && typeof block.agentId !== 'string',
    ),
  );
}

function clearSubagentIndexRetry(sessionId: string) {
  const timer = pendingSubagentIndexRetryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingSubagentIndexRetryTimers.delete(sessionId);
  }
  pendingSubagentIndexRetryAttempts.delete(sessionId);
}

function clearLiveSubagentParentKeys(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of liveSubagentParentKeys.keys()) {
    if (key.startsWith(prefix)) {
      liveSubagentParentKeys.delete(key);
    }
  }
}

function scheduleSubagentIndexRetry(
  sessionId: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  get: () => AgentState,
) {
  if (pendingSubagentIndexRetryTimers.has(sessionId)) {
    return;
  }

  const attempts = pendingSubagentIndexRetryAttempts.get(sessionId) ?? 0;
  if (attempts >= SUBAGENT_INDEX_MAX_RETRIES) {
    return;
  }

  const timer = setTimeout(() => {
    pendingSubagentIndexRetryTimers.delete(sessionId);
    pendingSubagentIndexRetryAttempts.set(sessionId, attempts + 1);
    void loadAndPatchClaudeSubagentIndex(sessionId, set, get, { retryIfEmpty: true });
  }, SUBAGENT_INDEX_RETRY_DELAY_MS);

  pendingSubagentIndexRetryTimers.set(sessionId, timer);
}

async function loadAndPatchClaudeSubagentIndex(
  sessionId: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  get: () => AgentState,
  options: { retryIfEmpty?: boolean } = {},
): Promise<void> {
  const state = get();
  if (state.subAgentIndexLoading[sessionId]) {
    return;
  }

  const cached = state.subAgentIndex[sessionId];
  if (cached) {
    if (Object.keys(cached).length > 0) {
      set((current) => {
        const existingEvents = current.events[sessionId] || [];
        const patched = applySubagentIndexToEvents(existingEvents, cached);
        return patched.changed
          ? { events: { ...current.events, [sessionId]: patched.events } }
          : {};
      });
      return;
    }
  }

  set((current) => ({
    subAgentIndexLoading: { ...current.subAgentIndexLoading, [sessionId]: true },
  }));

  try {
    const index = await agentApi.loadClaudeSubagentIndex(sessionId);
    set((current) => {
      const existingEvents = current.events[sessionId] || [];
      const patched = applySubagentIndexToEvents(existingEvents, index);
      const migrated = migrateSubagentLiveCaches(current.subAgentEvents, sessionId, index);
      return {
        subAgentIndex: { ...current.subAgentIndex, [sessionId]: index },
        subAgentIndexLoading: { ...current.subAgentIndexLoading, [sessionId]: false },
        ...(patched.changed ? { events: { ...current.events, [sessionId]: patched.events } } : {}),
        ...(migrated.changed ? { subAgentEvents: migrated.subAgentEvents } : {}),
      };
    });
    if (Object.keys(index).length > 0) {
      clearSubagentIndexRetry(sessionId);
      return;
    }

    const shouldRetry = Boolean(
      options.retryIfEmpty
      && hasUnpatchedAgentToolCall(get().events[sessionId] || []),
    );
    if (shouldRetry) {
      scheduleSubagentIndexRetry(sessionId, set, get);
    }
  } catch (err) {
    logger.error('Failed to load Claude sub-agent index', { sessionId }, serializeError(err));
    set((current) => ({
      subAgentIndex: { ...current.subAgentIndex, [sessionId]: {} },
      subAgentIndexLoading: { ...current.subAgentIndexLoading, [sessionId]: false },
    }));
  }
}

function clearSimulatedStream(sessionId: string) {
  const entry = pendingSimulatedStreams.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSimulatedStreams.delete(sessionId);
}

function commitPendingSimulatedStream(
  sessionId: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  const pendingSim = pendingSimulatedStreams.get(sessionId);
  if (!pendingSim) {
    return;
  }

  clearSimulatedStream(sessionId);
  clearPendingStreaming(sessionId);
  set((s) => {
    const prev = s.events[sessionId] || [];
    const timestamps = s.eventTimestamps[sessionId] || [];
    return {
      events: { ...s.events, [sessionId]: [...prev, pendingSim.event] },
      eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...timestamps, Date.now()] },
      streamingText: { ...s.streamingText, [sessionId]: '' },
    };
  });
}

function simulateStreamingText(
  sessionId: string,
  event: AgentMessage,
  text: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  // Clear any prior simulation for this session.
  clearSimulatedStream(sessionId);

  // Reset streaming state so StreamingContent starts fresh.
  set((s) => ({
    streamingText: { ...s.streamingText, [sessionId]: '' },
    streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
  }));

  const entry: SimulatedStreamEntry = { event, remaining: text, timer: 0 };
  pendingSimulatedStreams.set(sessionId, entry);

  const tick = () => {
    const current = pendingSimulatedStreams.get(sessionId);
    if (!current || current !== entry) return; // superseded or cleared

    if (!current.remaining) {
      // All chunks delivered — commit the event and clear streaming state.
      pendingSimulatedStreams.delete(sessionId);
      clearPendingStreaming(sessionId);
      set((s) => {
        const prev = s.events[sessionId] || [];
        const timestamps = s.eventTimestamps[sessionId] || [];
        return {
          events: { ...s.events, [sessionId]: [...prev, current.event] },
          eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...timestamps, Date.now()] },
          streamingText: { ...s.streamingText, [sessionId]: '' },
        };
      });
      return;
    }

    const size = Math.min(SIM_CHARS_PER_TICK, current.remaining.length);
    const chunk = current.remaining.slice(0, size);
    current.remaining = current.remaining.slice(size);

    queueStreamingDelta(sessionId, 'text', chunk, set);

    current.timer = window.setTimeout(tick, SIM_TICK_MS);
  };

  // Start on the next frame so the UI renders the empty streaming state first.
  entry.timer = window.setTimeout(tick, 30);
}

function parseAgentEvent(raw: string): AgentMessage {
  try {
    const data = JSON.parse(raw);

    // Filter out sub-agent (sidechain) messages from the main event stream.
    // These are loaded on demand via loadSubagentEvents when the user expands
    // the Agent tool call's sub-agent panel.
    if (isClaudeSubagentEvent(data)) {
      return { kind: 'raw', data };
    }

    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'sidecar_query_done':
        return { kind: 'done' };
      case 'mcp_status_update':
        return { kind: 'mcp_status', data: { servers: (data as any).servers || {}, status: (data as any).status } };
      case 'proxy_status':
        return { kind: 'proxy_status', data: { running: (data as any).running, port: (data as any).port, upstreamBaseUrl: (data as any).upstreamBaseUrl } };
      case 'codex_todo_list':
        return {
          kind: 'todo_list',
          data: {
            todos: Array.isArray((data as any).todos)
              ? (data as any).todos
                .map((todo: any) => ({
                  content: String(todo?.content || ''),
                  status: (['pending', 'in_progress', 'completed'].includes(todo?.status) ? todo.status : 'pending') as TodoItem['status'],
                  activeForm: todo?.activeForm || undefined,
                }))
                .filter((todo: TodoItem) => todo.content.length > 0)
              : [],
          },
        };
      case 'assistant':
        return { kind: 'assistant', data };
      case 'user':
        {
          const event = parseSdkUserMessage(data);
          if (event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)) {
            return { kind: 'raw', data };
          }
          if (event.kind === 'user') {
            if (
              data.isCompactSummary === true ||
              data.isVisibleInTranscriptOnly === true ||
              isClaudeCompactSummaryText(event.data.content)
            ) {
              return { kind: 'raw', data };
            }
            const normalized = normalizeClaudeUserEvent(event);
            return normalized ?? { kind: 'raw', data };
          }
          return event;
        }
      case 'system':
        if (data.subtype === 'init') {
          return { kind: 'system', data };
        }
        if (data.subtype === 'api_retry') {
          return { kind: 'api_retry', data };
        }
        if (data.subtype === 'compact_boundary') {
          return { kind: 'compact', data };
        }
        return { kind: 'raw', data };
      case 'result':
        return { kind: 'result', data };
      case 'ask_user_question':
        return { kind: 'ask_user_question', data };
      case 'file_snapshot':
        return { kind: 'file_snapshot', data };
      case 'stream_event':
        return { kind: 'streaming', data: { event: data.event, session_id: data.session_id } };
      case 'stream_event_batch':
        return { kind: 'streaming_batch', data: { events: Array.isArray(data.events) ? data.events : [], session_id: data.session_id } };
      case 'sidecar_debug':
        return { kind: 'raw', data };
      case 'sidecar_stream_status':
        return {
          kind: 'stream_status',
          data: {
            message: data.message,
            is_reconnecting: data.is_reconnecting,
            mode_blocked: isModeBlockedDiagnostic(data.mode_blocked) ? data.mode_blocked : null,
          },
        };
      case 'vision_unsupported':
        return { kind: 'raw', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

function getParentToolUseId(data: Record<string, unknown>): string | undefined {
  return typeof data.parent_tool_use_id === 'string' && data.parent_tool_use_id.length > 0
    ? data.parent_tool_use_id
    : undefined;
}

function isModeBlockedDiagnostic(value: unknown): value is ModeBlockedDiagnostic {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getEventUuid(data: Record<string, unknown>): string | undefined {
  return typeof data.uuid === 'string' && data.uuid.length > 0 ? data.uuid : undefined;
}

function getParentUuid(data: Record<string, unknown>): string | undefined {
  return typeof data.parentUuid === 'string' && data.parentUuid.length > 0 ? data.parentUuid : undefined;
}

function resolveLiveSubagentKey(sessionId: string, rawEvent: Record<string, unknown>): string | undefined {
  const parentToolUseId = getParentToolUseId(rawEvent);
  if (parentToolUseId) {
    return parentToolUseId;
  }

  const parentUuid = getParentUuid(rawEvent);
  return parentUuid ? liveSubagentParentKeys.get(`${sessionId}:${parentUuid}`) : undefined;
}

function rememberLiveSubagentKey(sessionId: string, rawEvent: Record<string, unknown>, subAgentKey: string) {
  const uuid = getEventUuid(rawEvent);
  if (uuid) {
    liveSubagentParentKeys.set(`${sessionId}:${uuid}`, subAgentKey);
  }
}

function appendLiveSubagentEvent(
  sessionId: string,
  rawEvent: Record<string, unknown>,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  const subAgentKey = resolveLiveSubagentKey(sessionId, rawEvent);
  if (!subAgentKey) {
    return;
  }
  rememberLiveSubagentKey(sessionId, rawEvent, subAgentKey);

  const parsed = mapPersistedClaudeMessage(rawEvent, 'claude_code', { includeSidechain: true });
  if (!parsed) {
    return;
  }

  const event = parsed as AgentMessage;
  const cacheKey = `${sessionId}:${subAgentKey}`;
  set((state) => {
    const existingEvents = state.subAgentEvents[cacheKey] ?? [];
    const incomingId = getEventStableId(event);
    if (incomingId && existingEvents.some((existing) => getEventStableId(existing) === incomingId)) {
      return {};
    }

    return {
      subAgentEvents: {
        ...state.subAgentEvents,
        [cacheKey]: [...existingEvents, event],
      },
    };
  });
}

function appendAgentToolResultSummaryToLiveSubagent(
  sessionId: string,
  event: Extract<AgentMessage, { kind: 'tool_result' }>,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  get: () => AgentState,
) {
  const mainEvents = get().events[sessionId] || [];
  const resultBlocks = getToolResultBlocks(event);

  for (const result of resultBlocks) {
    if (!hasAgentToolUseId(mainEvents, result.toolUseId)) {
      continue;
    }

    const summary = stripAgentToolResultMetadata(result.content);
    if (!summary) {
      continue;
    }

    const summaryEvent: AgentMessage = {
      kind: 'assistant',
      data: {
        type: 'assistant',
        uuid: `${event.data.uuid || 'tool-result'}:${result.toolUseId}:subagent-summary`,
        session_id: event.data.session_id,
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: summary }],
        },
        parent_tool_use_id: result.toolUseId,
      } as AgentAssistantMessage,
    };

    const cacheKey = `${sessionId}:${result.toolUseId}`;
    set((state) => {
      const existingEvents = state.subAgentEvents[cacheKey] ?? [];
      if (hasAssistantText(existingEvents, summary)) {
        return {};
      }

      const incomingId = getEventStableId(summaryEvent);
      if (incomingId && existingEvents.some((existing) => getEventStableId(existing) === incomingId)) {
        return {};
      }

      return {
        subAgentEvents: {
          ...state.subAgentEvents,
          [cacheKey]: [...existingEvents, summaryEvent],
        },
      };
    });
  }
}

function getToolResultBlocks(event: Extract<AgentMessage, { kind: 'tool_result' }>): Array<{ toolUseId: string; content: string }> {
  const content = event.data.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block) => {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      return [];
    }

    const text = stringifyToolResultContent(block.content);
    return text ? [{ toolUseId: block.tool_use_id, content: text }] : [];
  });
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return typeof block.text === 'string' ? block.text : '';
        }
        return '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  return '';
}

function stripAgentToolResultMetadata(result: string): string {
  return result
    .replace(/\n?agentId:\s*[a-zA-Z0-9_-]+[^\n]*(?:\n|$)/g, '\n')
    .replace(/\n?<usage>[\s\S]*?<\/usage>/g, '')
    .trim();
}

function hasAssistantText(events: AgentMessage[], text: string): boolean {
  return events.some((event) =>
    event.kind === 'assistant'
    && event.data.message.content.some((block) =>
      block?.type === 'text'
      && typeof block.text === 'string'
      && block.text.trim() === text.trim(),
    ),
  );
}

function truncateTitle(text: string, maxLen = 30): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + '...';
}

type FileOriginalSnapshot = { content: string; isNew: boolean; toolUseId?: string };

function findOriginalSnapshotKey(
  originals: Record<string, FileOriginalSnapshot>,
  filePath: string,
): string | undefined {
  const normalized = normalizeFilePath(filePath).toLowerCase();
  for (const key of Object.keys(originals)) {
    if (normalizeFilePath(key).toLowerCase() === normalized) {
      return key;
    }
  }
  return undefined;
}

function preserveFirstOriginalSnapshot(
  originals: Record<string, FileOriginalSnapshot>,
  filePath: string,
  snapshot: FileOriginalSnapshot,
): Record<string, FileOriginalSnapshot> {
  const existingKey = findOriginalSnapshotKey(originals, filePath);
  if (existingKey) return originals;
  return {
    ...originals,
    [filePath]: snapshot,
  };
}

function getSessionAgentKind(sessionId: string) {
  return useSessionStore.getState().sessions.find((session) => session.id === sessionId)?.agent_kind;
}

/**
 * Extract the current todo list from a stream of agent events.
 * Handles TodoWrite (full list replacement), TaskCreate/TaskUpdate (incremental),
 * and infers status from tool execution flow when TodoWrite doesn't update statuses.
 */

/**
 * Build a synthetic result event for a single turn (Claude Code historical sessions).
 * Accumulates usage from assistant messages between startIdx (inclusive) and endIdx (exclusive).
 */
function buildTurnSyntheticResult(
  events: AgentMessage[],
  timestamps: number[],
  startIdx: number,
  endIdx: number,
  turnStartTime: number,
  sessionId: string,
): { insertAt: number; result: AgentMessage } | null {
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  let lastAssistantIdx = -1;

  for (let i = startIdx; i < endIdx; i++) {
    if (events[i].kind === 'assistant') {
      lastAssistantIdx = i;
      const evt = events[i] as any;
      const usage = evt.data?.message?.usage || evt.data?.usage;
      if (usage) {
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreate += usage.cache_creation_input_tokens || 0;
      }
    }
  }

  if (totalInput === 0 && totalOutput === 0) return null;
  if (lastAssistantIdx < 0) return null;

  const endTime = timestamps[endIdx - 1] || timestamps[lastAssistantIdx] || 0;
  const durationMs = endTime > turnStartTime ? endTime - turnStartTime : 0;

  return {
    insertAt: lastAssistantIdx,
    result: {
      kind: 'result',
      data: {
        type: 'result', subtype: 'success', is_error: false,
        uuid: `synthetic-turn-${sessionId}-${startIdx}`, session_id: sessionId,
        duration_ms: durationMs, duration_api_ms: 0,
        num_turns: 1, result: '', total_cost_usd: 0,
        usage: {
          input_tokens: totalInput, output_tokens: totalOutput,
          cache_creation_input_tokens: totalCacheCreate, cache_read_input_tokens: totalCacheRead,
        },
      } as AgentResultMessage,
    },
  };
}

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

        // TodoWrite / Codex update_plan: replaces the entire todo list
        if (block.name === 'TodoWrite' || block.name === 'update_plan') {
          const input = block.input as any;
          const inputTodos = block.name === 'TodoWrite' ? input?.todos : input?.plan;
          if (Array.isArray(inputTodos)) {
            const newTodos = inputTodos.map((t: any) => ({
              content: String(t.content || t.step || ''),
              status: (['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending') as TodoItem['status'],
              activeForm: t.activeForm || undefined,
            }));
            // Check if this task update has any non-pending status
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
          continue; // skip inference for task-management tools
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
        const skipInferenceTools = ['TodoWrite', 'update_plan', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
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

export function extractChangedFilesFromEvents(
  events: AgentMessage[],
  acknowledged?: Set<string>,
  originals?: Record<string, FileOriginalSnapshot>,
): ChangedFile[] {
  const fileMap = new Map<string, ChangedFile>();
  let effectiveOriginals = originals;

  for (const evt of events) {
    if (evt.kind !== 'file_snapshot') continue;
    effectiveOriginals = preserveFirstOriginalSnapshot(
      effectiveOriginals || {},
      evt.data.file_path,
      {
        content: evt.data.original_content,
        isNew: evt.data.is_new,
        toolUseId: evt.data.tool_use_id,
      },
    );
  }

  // Build a normalized lookup for originals (snapshot paths may differ from tool input paths)
  const normalizedOriginals = new Map<string, FileOriginalSnapshot>();
  // Also build a lookup by tool_use_id for matching when paths differ (relative vs absolute)
  const originalsByToolId = new Map<string, { content: string; isNew: boolean }>();
  // Also build a suffix lookup for relative-vs-absolute path matching
  const originalsBySuffix = new Map<string, FileOriginalSnapshot>();
  if (effectiveOriginals) {
    for (const [k, v] of Object.entries(effectiveOriginals)) {
      const normalized = normalizeFilePath(k);
      normalizedOriginals.set(normalized, v);
      if (v.toolUseId) {
        originalsByToolId.set(v.toolUseId, v);
      }
      // Store lowercase suffix keys for relative path matching (strip drive letter)
      const lower = normalized.toLowerCase();
      originalsBySuffix.set(lower, v);
      const driveMatch = lower.match(/^[a-z]:\\(.+)$/);
      if (driveMatch) {
        originalsBySuffix.set(driveMatch[1], v);
      }
    }
  }

  // Helper: find snapshot by normalized path, tool ID, or suffix match
  const findSnapshot = (filePath: string, toolUseId?: string) => {
    const normalized = normalizeFilePath(filePath);
    const exact = normalizedOriginals.get(normalized);
    if (exact) return exact;
    if (toolUseId) {
      const byId = originalsByToolId.get(toolUseId);
      if (byId) return byId;
    }
    // Suffix match: tool input "src/foo.ts" matches snapshot "D:\project\src\foo.ts"
    const lower = normalized.toLowerCase();
    for (const [suffix, val] of originalsBySuffix) {
      if (suffix.endsWith(lower) || lower.endsWith(suffix)) return val;
    }
    return undefined;
  };

  for (const evt of events) {
    if (evt.kind !== 'assistant') continue;
    const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];

    for (const block of blocks) {
      if (block?.type !== 'tool_use' || !block.name) continue;
      const input = block.input as Record<string, unknown>;

      if (block.name === 'Write') {
        const rawPath = input?.file_path as string;
        const fileContent = input?.content as string;
        if (!rawPath || typeof fileContent !== 'string') continue;
        const filePath = normalizeFilePath(rawPath);
        const toolUseId = block.id as string | undefined;

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.currentContent = fileContent;
          existing._pendingEdits = undefined;
          const orig = existing.originalContent ?? '';
          const { additions, deletions } = countDiffLines(orig, fileContent);
          existing.additions = additions;
          existing.deletions = deletions;
        } else {
          const snapshot = findSnapshot(rawPath, toolUseId);
          const origContent = snapshot?.content ?? '';
          const isNew = snapshot?.isNew ?? true;
          const { additions, deletions } = countDiffLines(origContent, fileContent);
          fileMap.set(filePath, {
            path: filePath,
            isNew,
            originalContent: origContent,
            currentContent: fileContent,
            additions,
            deletions,
          });
        }
      }

      if (block.name === 'Edit') {
        const rawPath = input?.file_path as string;
        const oldString = input?.old_string as string;
        const newString = input?.new_string as string;
        if (!rawPath || typeof oldString !== 'string' || typeof newString !== 'string') continue;
        const filePath = normalizeFilePath(rawPath);
        const toolUseId = block.id as string | undefined;

        const existing = fileMap.get(filePath);
        if (existing) {
          if (existing.currentContent) {
            const idx = existing.currentContent.indexOf(oldString);
            if (idx !== -1) {
              existing.currentContent =
                existing.currentContent.slice(0, idx) +
                newString +
                existing.currentContent.slice(idx + oldString.length);
            }
            const orig = existing.originalContent ?? '';
            const { additions, deletions } = countDiffLines(orig, existing.currentContent);
            existing.additions = additions;
            existing.deletions = deletions;
          } else {
            (existing._pendingEdits ||= []).push({ oldString, newString });
          }
        } else {
          const snapshot = findSnapshot(rawPath, toolUseId);
          if (snapshot) {
            let current = snapshot.content;
            const idx = current.indexOf(oldString);
            if (idx !== -1) {
              current = current.slice(0, idx) + newString + current.slice(idx + oldString.length);
            }
            const { additions, deletions } = countDiffLines(snapshot.content, current);
            fileMap.set(filePath, {
              path: filePath,
              isNew: false,
              originalContent: snapshot.content,
              currentContent: current,
              additions,
              deletions,
            });
          } else {
            fileMap.set(filePath, {
              path: filePath,
              isNew: false,
              originalContent: undefined,
              currentContent: '',
              additions: 0,
              deletions: 0,
              _pendingEdits: [{ oldString, newString }],
            });
          }
        }
      }
    }
  }

  const allFiles = Array.from(fileMap.values());

  if (acknowledged && acknowledged.size > 0) {
    return allFiles.filter((f) => !acknowledged.has(f.path));
  }

  return allFiles;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  eventTimestamps: {},
  isRunning: {},
  queryStartTime: {},
  error: {},
  mcpRuntimeStatus: {},
  todos: {},
  streamingThinking: {},
  streamingText: {},
  streamingThinkingDurations: {},
  forceStopped: {},
  streamingToolInputs: {},
  streamingToolMeta: {},
  streamingToolIndexMap: {},
  streamedToolUseIds: {},
  changedFiles: {},
  fileOriginals: {},
  acknowledgedFiles: {},
  subAgentEvents: {},
  subAgentLoading: {},
  subAgentIndex: {},
  subAgentIndexLoading: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string, reasoningEffort?: ReasoningEffort, codexNeedsProxy?: boolean, displayContent?: string, inputPayload?: AgentInputPayload) => {
    clearPendingStreaming(sessionId);
    clearPendingStreamingToolInputs(sessionId);
    pendingThinkingStartTimes.delete(sessionId);
    // Clear streaming thinking durations for new query
    set((s) => ({
      streamingThinkingDurations: { ...s.streamingThinkingDurations, [sessionId]: [] },
    }));
    logger.info('MODEL_TRACE startQuery dispatching to Tauri', {
      sessionId,
      cwd,
      runtimeModel: model || 'default',
      reasoningEffort: reasoningEffort || 'medium',
      promptLength: prompt.length,
      hasApiKey: Boolean(apiKey),
      baseUrl: baseUrl || null,
      codexNeedsProxy: codexNeedsProxy ?? null,
    });
    // Clear force-stopped flag when starting a new query
    set((s) => ({ forceStopped: { ...s.forceStopped, [sessionId]: false } }));
    // Auto-update session title from the first user message (skip slash commands)
    const state = get();
    const hasExistingUserMsg = (state.events[sessionId] || []).some(e => e.kind === 'user');
    const originalPayload = inputPayload ?? { text: prompt };
    const shouldSendImages = (originalPayload.images?.length ?? 0) > 0 && inferModelSupportsVision(model);
    const payloadForModel: AgentInputPayload = shouldSendImages
      ? originalPayload
      : { text: originalPayload.text };
    const droppedImages = (originalPayload.images?.length ?? 0) > 0 && !shouldSendImages;
    const userContent = displayContent ?? originalPayload.text;
    const userAttachments = originalPayload.images?.map((image) => ({
      type: 'image' as const,
      name: image.name,
      mediaType: image.mediaType,
      dataUrl: image.dataUrl,
    }));
    if (!hasExistingUserMsg && !userContent.startsWith('/')) {
      const title = truncateTitle(userContent);
      if (title) {
        useSessionStore.getState().updateSessionTitle(sessionId, title);
      }
    }

    // Update session activity timestamp
    useSessionStore.getState().touchSession(sessionId);

    // Git baseline is no longer needed since we use HEAD comparison directly

    // 添加用户消息到事件列表
    const userMsg: AgentMessage = {
      kind: 'user',
      data: {
        content: userContent,
        attachments: userAttachments,
      },
    };
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
      queryStartTime: { ...s.queryStartTime, [sessionId]: Date.now() },
      error: { ...s.error, [sessionId]: null },
    }));
    try {
      if (droppedImages) {
        logger.info('Skipping image payload for model without vision support', {
          sessionId,
          model: model || 'default',
        });
      }

      await agentApi.startSession(sessionId, payloadForModel.text, cwd, (raw: string) => {
        let event = parseAgentEvent(raw);
        const now = Date.now();

        // Skip sub-agent (sidechain) messages — they are loaded on demand
        // via loadSubagentEvents when the user expands the Agent tool call.
        if (event.kind === 'raw' && isClaudeSubagentEvent(event.data)) {
          appendLiveSubagentEvent(sessionId, event.data, set);
          return;
        }

        if (event.kind === 'raw' && event.data?.type === 'vision_unsupported') {
          markModelVisionUnsupported(typeof event.data.model === 'string' ? event.data.model : model);
          set((s) => ({
            events: {
              ...s.events,
              [sessionId]: [
                ...(s.events[sessionId] || []),
                { kind: 'stream_status', data: { message: '当前模型不支持图片识别，已自动改为仅发送文本。', is_reconnecting: false } },
              ],
            },
            eventTimestamps: {
              ...s.eventTimestamps,
              [sessionId]: [...(s.eventTimestamps[sessionId] || []), now],
            },
          }));
          return;
        }

        if (event.kind === 'raw' && event.data?.type === 'sidecar_debug') {
          return;
        }

        if (event.kind === 'raw' && isClaudeCompactSummaryRawEvent(event.data)) {
          return;
        }

        if (event.kind === 'error' && /Codex session not initialized\. Call ensure_session first\./i.test(event.data.error)) {
          const existingEvents = get().events[sessionId] || [];
          const alreadyFailedProxyStartup = existingEvents.some((existingEvent) =>
            existingEvent.kind === 'error' &&
            /EADDRINUSE|address already in use|listen .*15722/i.test(existingEvent.data.error),
          );

          if (alreadyFailedProxyStartup) {
            logger.warn('Suppressing cascading Codex initialization error after proxy startup failure', {
              sessionId,
            });
            return;
          }
        }

        if (event.kind === 'todo_list') {
          const todoEvent = event;
          set((s) => ({
            todos: { ...s.todos, [sessionId]: todoEvent.data.todos },
          }));
          return;
        }

        // Handle file_snapshot events: store original content captured before
        // Write/Edit tool execution, then re-extract changed files.
        if (event.kind === 'file_snapshot') {
          const { file_path, original_content, is_new, tool_use_id } = event.data;
          set((s) => {
            const sessionOriginals = preserveFirstOriginalSnapshot(
              s.fileOriginals[sessionId] || {},
              file_path,
              { content: original_content, isNew: is_new, toolUseId: tool_use_id },
            );
            const updatedOriginals = { ...s.fileOriginals, [sessionId]: sessionOriginals };
            const existingEvents = s.events[sessionId] || [];
            return {
              fileOriginals: updatedOriginals,
              changedFiles: {
                ...s.changedFiles,
                [sessionId]: extractChangedFilesFromEvents(existingEvents, s.acknowledgedFiles[sessionId], sessionOriginals),
              },
            };
          });
          return;
        }

        // Handle streaming events (thinking/text deltas + tool_use) separately
        if (event.kind === 'streaming' || event.kind === 'streaming_batch') {
          if (!get().isRunning[sessionId] || get().forceStopped[sessionId]) return;
          const streamEvents = event.kind === 'streaming_batch' ? event.data.events : [event.data.event];
          for (const rawStreamEvent of streamEvents) {
          const streamEvent = rawStreamEvent as Record<string, unknown>;
          const eventType = streamEvent.type as string;
          const findToolId = (idx: number | undefined): string | undefined => {
            if (idx !== undefined) {
              const byIndex = get().streamingToolIndexMap[sessionId]?.[idx];
              if (byIndex) return byIndex;
            }
            const meta = get().streamingToolMeta[sessionId];
            if (!meta) return undefined;
            const entries = Object.entries(meta);
            return entries.length > 0 ? entries[entries.length - 1][0] : undefined;
          };

          if (eventType === 'content_block_start') {
            const contentBlock = streamEvent.content_block as Record<string, unknown> | undefined;
            if (contentBlock?.type === 'thinking') {
              flushPendingStreaming(sessionId, set);
              pendingThinkingStartTimes.set(sessionId, Date.now());
              clearStreamingTextField(sessionId, 'streamingThinking', set, get);
            } else if (contentBlock?.type === 'text') {
              flushPendingStreaming(sessionId, set);
              clearStreamingTextField(sessionId, 'streamingText', set, get);
            } else if (contentBlock?.type === 'tool_use') {
              const toolId = contentBlock.id as string;
              const toolName = contentBlock.name as string;
              const blockIndex = streamEvent.index as number | undefined;
              set((s) => ({
                streamingToolMeta: {
                  ...s.streamingToolMeta,
                  [sessionId]: { ...(s.streamingToolMeta[sessionId] || {}), [toolId]: { name: toolName, index: blockIndex ?? -1 } },
                },
                streamingToolInputs: {
                  ...s.streamingToolInputs,
                  [sessionId]: { ...(s.streamingToolInputs[sessionId] || {}), [toolId]: '' },
                },
                streamingToolIndexMap: blockIndex !== undefined
                  ? { ...s.streamingToolIndexMap, [sessionId]: { ...(s.streamingToolIndexMap[sessionId] || {}), [blockIndex]: toolId } }
                  : s.streamingToolIndexMap,
              }));
            }
          } else if (eventType === 'content_block_delta') {
            const delta = streamEvent.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const toolId = findToolId(streamEvent.index as number | undefined);
              if (toolId) {
                appendPendingStreamingToolInput(sessionId, toolId, delta.partial_json);
              }
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              queueStreamingDelta(sessionId, 'thinking', delta.thinking, set);
            } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              queueStreamingDelta(sessionId, 'text', delta.text, set);
            }
          } else if (eventType === 'content_block_stop') {
            logStreamingTelemetry(sessionId, 'content_block_stop');
            streamingTelemetry.delete(sessionId);
            const blockIndex = streamEvent.index as number | undefined;
            const toolId = findToolId(blockIndex);
            const toolMeta = toolId ? get().streamingToolMeta[sessionId]?.[toolId] : undefined;
            if (toolId && toolMeta) {
              // Skip if this tool_use block already exists in events (real event arrived first)
              const alreadyExists = (get().events[sessionId] || []).some((evt) =>
                evt.kind === 'assistant' && (evt.data?.message?.content || []).some((b: any) => b?.type === 'tool_use' && b.id === toolId)
              );
              if (alreadyExists) {
                clearPendingStreamingToolInputs(sessionId);
                set((s) => ({
                  streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                  streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                  streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                }));
                return;
              }
              const rawJson = readPendingStreamingToolInput(sessionId, toolId, get()) || '{}';
              let parsedInput: Record<string, unknown> = {};
              try { parsedInput = JSON.parse(rawJson); } catch {}

              // Capture original file content from disk BEFORE the tool executes.
              // At content_block_stop time the file is still unmodified on disk.
              // Fire-and-forget: snapshot is stored async, re-extraction happens on next event.
              if ((toolMeta.name === 'Write' || toolMeta.name === 'Edit') && parsedInput.file_path) {
                const filePath = parsedInput.file_path as string;
                const projectPath = usePreviewStore.getState().projectPath || undefined;
                fileApi.readFile(filePath, projectPath).then((original) => {
                  set((s) => {
                    const sessionOriginals = preserveFirstOriginalSnapshot(
                      s.fileOriginals[sessionId] || {},
                      filePath,
                      { content: original, isNew: false, toolUseId: toolId },
                    );
                    const events = s.events[sessionId] || [];
                    return {
                      fileOriginals: { ...s.fileOriginals, [sessionId]: sessionOriginals },
                      changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(events, s.acknowledgedFiles[sessionId], sessionOriginals) },
                    };
                  });
                }).catch(() => {
                  set((s) => {
                    const sessionOriginals = preserveFirstOriginalSnapshot(
                      s.fileOriginals[sessionId] || {},
                      filePath,
                      { content: '', isNew: true, toolUseId: toolId },
                    );
                    return { fileOriginals: { ...s.fileOriginals, [sessionId]: sessionOriginals } };
                  });
                });
              }

              const toolUseBlock: import('../types/agent').ContentBlock = {
                type: 'tool_use',
                id: toolId,
                name: toolMeta.name,
                input: parsedInput,
              };
              const syntheticAssistant: import('../types/agent').AgentAssistantMessage = {
                type: 'assistant',
                uuid: `stream-${toolId}`,
                session_id: sessionId,
                message: { role: 'assistant', content: [toolUseBlock] },
                parent_tool_use_id: null,
              };
              const syntheticEvent: AgentMessage = { kind: 'assistant', data: syntheticAssistant };
              clearPendingStreamingToolInputs(sessionId);
              set((s) => {
                const prev = s.events[sessionId] || [];
                const newEvents = [...prev, syntheticEvent];
                const extractedTodos = extractTodosFromEvents(newEvents);
                const prevIds = s.streamedToolUseIds[sessionId] || new Set<string>();
                const newIds = new Set(prevIds);
                newIds.add(toolId);
                // Un-acknowledge files that have new edits/writes since last save
                let acknowledged = s.acknowledgedFiles[sessionId];
                if (acknowledged && acknowledged.size > 0) {
                  const rawPath = parsedInput.file_path as string;
                  if (rawPath && acknowledged.has(normalizeFilePath(rawPath))) {
                    const newAcknowledged = new Set(acknowledged);
                    newAcknowledged.delete(normalizeFilePath(rawPath));
                    acknowledged = newAcknowledged;
                    try {
                      localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
                    } catch {}
                  }
                }
                return {
                  events: { ...s.events, [sessionId]: newEvents },
                  eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...(s.eventTimestamps[sessionId] || []), now] },
                  todos: { ...s.todos, [sessionId]: extractedTodos.length > 0 ? extractedTodos : (s.todos[sessionId] || []) },
                  changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(newEvents, acknowledged, s.fileOriginals[sessionId]) },
                  streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                  streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                  streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                  streamedToolUseIds: { ...s.streamedToolUseIds, [sessionId]: newIds },
                  ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
                };
              });
              if (getSessionAgentKind(sessionId) === 'claude_code' && isAgentToolName(toolMeta.name)) {
                void loadAndPatchClaudeSubagentIndex(sessionId, set, get, { retryIfEmpty: true });
              }
            } else {
              flushPendingStreaming(sessionId, set);
            }
          }
          }
          return;
        }

        const forceStopped = get().forceStopped[sessionId] ?? false;
        if (forceStopped && shouldSuppressLiveEventWhileStopped(event.kind)) {
          if (event.kind === 'result') {
            const resultData = event.data;
            clearPendingStreaming(sessionId);
            set((s) => {
              const { [sessionId]: _removed, ...rest } = s.queryStartTime;
              return {
                isRunning: { ...s.isRunning, [sessionId]: false },
                queryStartTime: rest,
                streamingText: { ...s.streamingText, [sessionId]: '' },
                streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
                streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                streamedToolUseIds: { ...s.streamedToolUseIds, [sessionId]: new Set() },
                ...(resultData.is_error
                  ? { error: { ...s.error, [sessionId]: resultData.result || 'Request interrupted' } }
                  : {}),
              };
            });
            useSessionStore.getState().markSessionUnread(sessionId);
          }
          return;
        }

        // When the complete assistant message arrives, filter out blocks
        // that were already displayed via streaming to avoid duplicate display.
        if (event.kind === 'assistant') {
          // Commit any pending simulated stream immediately before processing.
          commitPendingSimulatedStream(sessionId, set);

          flushPendingStreaming(sessionId, set);
          const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
          // Collect all tool_use IDs already present in events (covers race condition)
          const existingToolIds = new Set<string>();
          for (const prevEvt of (get().events[sessionId] || [])) {
            if (prevEvt.kind === 'assistant') {
              for (const b of (prevEvt.data?.message?.content || [])) {
                if (b?.type === 'tool_use' && b.id) existingToolIds.add(b.id);
              }
            }
          }
          const toolUseReplacements = new Map<string, unknown>();
          const filtered = blocks.filter((b: any) => {
            if (b?.type === 'tool_use' && existingToolIds.has(b.id)) {
              if (typeof b.id === 'string') toolUseReplacements.set(b.id, b);
              return false;
            }
            return true;
          });
          const replacedExistingTools = toolUseReplacements.size > 0
            ? replaceToolUseBlocksInEvents(get().events[sessionId] || [], toolUseReplacements)
            : { events: get().events[sessionId] || [], changed: false };
          if (filtered.length !== blocks.length) {
            event = {
              ...event,
              data: { ...event.data, message: { ...event.data.message, content: filtered } },
            };
          }

          // If the event only carries text (no tool_use) and the SDK did not
          // stream it incrementally (streamingText is empty), simulate a
          // token-by-token render so the user sees text appear progressively.
          const textBlock = filtered.find(
            (b: any): b is { type: 'text'; text: string } =>
              b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0,
          );
          const hasToolUse = filtered.some((b: any) => b?.type === 'tool_use');
          const currentStreamingText = get().streamingText[sessionId] || '';
          const currentStreamingThinking = get().streamingThinking[sessionId] || '';
          const hasLiveTextStream = sessionsWithLiveTextStream.has(sessionId);
          const finalTextReplacesLiveText = Boolean(
            textBlock
            && !hasToolUse
            && hasLiveTextStream
            && currentStreamingText
            && (
              textBlock.text === currentStreamingText
              || textBlock.text.startsWith(currentStreamingText)
              || currentStreamingText.startsWith(textBlock.text)
            ),
          );
          if (textBlock && !hasToolUse && !currentStreamingText && !currentStreamingThinking) {
            simulateStreamingText(sessionId, event, textBlock.text, set);
            return;
          }

          // Compute thinking duration from streaming timestamps
          const hasThinkingBlock = filtered.some((b: any) => b?.type === 'thinking');
          if (hasThinkingBlock) {
            const thinkingStart = pendingThinkingStartTimes.get(sessionId);
            pendingThinkingStartTimes.delete(sessionId);
            if (thinkingStart) {
              const duration = Date.now() - thinkingStart;
              if (duration > 0) {
                set((s) => ({
                  streamingThinkingDurations: {
                    ...s.streamingThinkingDurations,
                    [sessionId]: [...(s.streamingThinkingDurations[sessionId] || []), duration],
                  },
                }));
              }
            }
          }

          set((s) => {
            const updates: Partial<AgentState> = {};
            if (replacedExistingTools.changed) {
              updates.events = { ...s.events, [sessionId]: replacedExistingTools.events };
              const extractedTodos = extractTodosFromEvents(replacedExistingTools.events);
              updates.todos = {
                ...s.todos,
                [sessionId]: extractedTodos.length > 0 ? extractedTodos : (s.todos[sessionId] || []),
              };
              updates.changedFiles = {
                ...s.changedFiles,
                [sessionId]: extractChangedFilesFromEvents(
                  replacedExistingTools.events,
                  s.acknowledgedFiles[sessionId],
                  s.fileOriginals[sessionId],
                ),
              };
            }
            if (s.streamingThinking[sessionId]) updates.streamingThinking = { ...s.streamingThinking, [sessionId]: '' };
            if (s.streamingText[sessionId]) updates.streamingText = { ...s.streamingText, [sessionId]: '' };
            if (finalTextReplacesLiveText) {
              sessionsWithLiveTextStream.delete(sessionId);
            }
            if (s.streamedToolUseIds[sessionId]?.size) {
              updates.streamedToolUseIds = { ...s.streamedToolUseIds, [sessionId]: new Set<string>() };
            }
            return updates;
          });

          if (filtered.length === 0 && replacedExistingTools.changed) {
            return;
          }
        }

        if (event.kind === 'result') {
          commitPendingSimulatedStream(sessionId, set);
        }

        set((s) => {
          const prev = s.events[sessionId] || [];
          // Replace the previous reconnecting status instead of stacking
          let newEvents: AgentMessage[];
          if (event.kind === 'stream_status' && event.data.is_reconnecting) {
            let replaceIdx = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              const e = prev[i];
              if (isReconnectingStreamStatus(e)) {
                replaceIdx = i;
                break;
              }
            }
            newEvents = replaceIdx >= 0
              ? [...prev.slice(0, replaceIdx), event, ...prev.slice(replaceIdx + 1)]
              : [...prev, event];
          } else {
            newEvents = [...prev, event];
          }
          if (isTerminalAgentEvent(event.kind, Boolean(event.kind === 'result' && event.data?.is_error))) {
            newEvents = newEvents.filter((entry) => !isReconnectingStreamStatus(entry));
          }
          const extractedTodos = extractTodosFromEvents(newEvents);

          // Un-acknowledge files that have new edits/writes since last save
          let acknowledged = s.acknowledgedFiles[sessionId];
          if (acknowledged && acknowledged.size > 0 && event.kind === 'assistant') {
            const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
            const newAcknowledged = new Set(acknowledged);
            let changed = false;
            for (const block of blocks) {
              if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
                const rawPath = block.input?.file_path as string;
                if (rawPath && newAcknowledged.has(normalizeFilePath(rawPath))) {
                  newAcknowledged.delete(normalizeFilePath(rawPath));
                  changed = true;
                }
              }
            }
            if (changed) {
              acknowledged = newAcknowledged;
              try {
                localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
              } catch {}
            }
          }

          return {
            events: { ...s.events, [sessionId]: newEvents },
            eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...(s.eventTimestamps[sessionId] || []), now] },
            todos: { ...s.todos, [sessionId]: extractedTodos.length > 0 ? extractedTodos : (s.todos[sessionId] || []) },
            changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(newEvents, acknowledged, s.fileOriginals[sessionId]) },
            ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
          };
        });
        if (event.kind === 'tool_result') {
          appendAgentToolResultSummaryToLiveSubagent(sessionId, event, set, get);
        }
        if (
          getSessionAgentKind(sessionId) === 'claude_code'
          && (hasAgentToolCall(event) || event.kind === 'tool_result')
        ) {
          void loadAndPatchClaudeSubagentIndex(sessionId, set, get, { retryIfEmpty: true });
        }
        // Update MCP runtime status from polling results (local to agentStore)
        if (event.kind === 'mcp_status') {
          if (event.data.status) {
            set((s) => ({
              mcpRuntimeStatus: { ...s.mcpRuntimeStatus, [sessionId]: event.data.status || null },
            }));
          }
        }
        // Update proxy status with local URL from sidecar
        if (event.kind === 'proxy_status') {
          const localUrl = event.data.running && event.data.port
            ? `http://127.0.0.1:${event.data.port}`
            : null;
          useSettingsStore.getState().setProxyRunning(event.data.running, localUrl);
        }

        const isTerminalEvent = isTerminalAgentEvent(event.kind, Boolean(event.kind === 'result' && event.data?.is_error));
        if (isTerminalEvent && !shouldProcessTerminalEvent(get().isRunning[sessionId] ?? false, event.kind, Boolean(event.kind === 'result' && event.data?.is_error))) {
          return;
        }

        if (isTerminalEvent) {
          clearPendingStreaming(sessionId);
          clearPendingStreamingToolInputs(sessionId);
          set((s) => {
            const { [sessionId]: _removed, ...rest } = s.queryStartTime;
            return {
              isRunning: { ...s.isRunning, [sessionId]: false },
              queryStartTime: rest,
              streamingText: { ...s.streamingText, [sessionId]: '' },
              streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
              error: event.kind === 'error'
              ? { ...s.error, [sessionId]: event.data.error }
              : s.error,
            };
          });
          useSessionStore.getState().markSessionUnread(sessionId);
          logger.info('Agent query finished', {
            sessionId,
            terminalEvent: event.kind,
            isError: event.kind === 'error' || (event.kind === 'result' && Boolean(event.data?.is_error)),
          });
        }
      }, apiKey, baseUrl, model, reasoningEffort, codexNeedsProxy, payloadForModel);
    } catch (err) {
      logger.error('Agent query failed to start or stream', { sessionId, cwd, model }, serializeError(err));
      set((s) => {
        const { [sessionId]: _removed, ...rest } = s.queryStartTime;
        return {
          isRunning: { ...s.isRunning, [sessionId]: false },
          queryStartTime: rest,
          error: { ...s.error, [sessionId]: String(err) },
        };
      });
      useSessionStore.getState().markSessionUnread(sessionId);
    }
  },

  interrupt: async (sessionId: string) => {
    clearPendingStreaming(sessionId);
    clearPendingStreamingToolInputs(sessionId);
    clearSimulatedStream(sessionId);
    pendingThinkingStartTimes.delete(sessionId);
    const state = get();
    const isRunning = state.isRunning[sessionId] ?? false;
    const forceStopped = state.forceStopped[sessionId] ?? false;
    const events = state.events[sessionId] || [];
    const lastEvent = events[events.length - 1];

    if (!isRunning || forceStopped || lastEvent?.kind === 'done') {
      logger.info('Ignoring interrupt for inactive agent query', {
        sessionId,
        isRunning,
        forceStopped,
        lastEvent: lastEvent?.kind ?? 'none',
      });
      return;
    }

    logger.info('Interrupting agent query', { sessionId });
    clearSubagentIndexRetry(sessionId);
    clearLiveSubagentParentKeys(sessionId);
    // 1. Immediately update UI — BEFORE sending command to sidecar
    set((s) => {
      const { [sessionId]: _removed, ...rest } = s.queryStartTime;
      return {
        forceStopped: { ...s.forceStopped, [sessionId]: true },
        isRunning: { ...s.isRunning, [sessionId]: false },
        queryStartTime: rest,
        streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
        streamingText: { ...s.streamingText, [sessionId]: '' },
      };
    });

    // 2. Then tell sidecar to stop (async, non-blocking for UI)
    try {
      await agentApi.interrupt(sessionId);
    } catch {
      // Sidecar may already be gone — UI is already stopped.
    }
  },

  clearEvents: (sessionId: string) => {
    clearPendingStreaming(sessionId);
    clearSimulatedStream(sessionId);
    clearSubagentIndexRetry(sessionId);
    clearLiveSubagentParentKeys(sessionId);
    pendingThinkingStartTimes.delete(sessionId);
    set((state) => {
      const newEvents = { ...state.events };
      delete newEvents[sessionId];
      const newTimestamps = { ...state.eventTimestamps };
      delete newTimestamps[sessionId];
      const newRunning = { ...state.isRunning };
      delete newRunning[sessionId];
      const newError = { ...state.error };
      delete newError[sessionId];
      const newMcpRuntimeStatus = { ...state.mcpRuntimeStatus };
      delete newMcpRuntimeStatus[sessionId];
      const newTodos = { ...state.todos };
      delete newTodos[sessionId];
      const newStreaming = { ...state.streamingThinking };
      delete newStreaming[sessionId];
      const newStreamingText = { ...state.streamingText };
      delete newStreamingText[sessionId];
      const newStreamingDurations = { ...state.streamingThinkingDurations };
      delete newStreamingDurations[sessionId];
      const newForceStopped = { ...state.forceStopped };
      delete newForceStopped[sessionId];
      // Clean up sub-agent events for this session
      const newSubAgentEvents = { ...state.subAgentEvents };
      const newSubAgentLoading = { ...state.subAgentLoading };
      const newSubAgentIndex = { ...state.subAgentIndex };
      const newSubAgentIndexLoading = { ...state.subAgentIndexLoading };
      for (const key of Object.keys(newSubAgentEvents)) {
        if (key.startsWith(`${sessionId}:`)) {
          delete newSubAgentEvents[key];
        }
      }
      for (const key of Object.keys(newSubAgentLoading)) {
        if (key.startsWith(`${sessionId}:`)) {
          delete newSubAgentLoading[key];
        }
      }
      delete newSubAgentIndex[sessionId];
      delete newSubAgentIndexLoading[sessionId];
      return { events: newEvents, eventTimestamps: newTimestamps, isRunning: newRunning, error: newError, mcpRuntimeStatus: newMcpRuntimeStatus, todos: newTodos, streamingThinking: newStreaming, streamingText: newStreamingText, streamingThinkingDurations: newStreamingDurations, forceStopped: newForceStopped, subAgentEvents: newSubAgentEvents, subAgentLoading: newSubAgentLoading, subAgentIndex: newSubAgentIndex, subAgentIndexLoading: newSubAgentIndexLoading };
    });
  },

  loadSessionMessages: async (sessionId: string) => {
    // Don't reload if we already have events for this session
    const existing = get().events[sessionId];
    if (existing && existing.length > 0) {
      return;
    }

    const agentKind = getSessionAgentKind(sessionId);

    try {
      const jsonlMessages = agentKind === 'codex'
        ? await agentApi.loadCodexSessionEvents(sessionId)
        : await agentApi.loadClaudeSessionEvents(sessionId);

      if (!jsonlMessages || jsonlMessages.length === 0) {
        logger.info('No agent JSONL history found for session', {
          sessionId,
          agentKind: agentKind ?? 'claude_code',
        });
        return;
      }

      const subagentIndex = agentKind === 'claude_code'
        ? await agentApi.loadClaudeSubagentIndex(sessionId).catch((err) => {
          logger.error('Failed to load Claude sub-agent index while loading history', { sessionId }, serializeError(err));
          return {};
        })
        : {};

      const events: AgentMessage[] = [];
      const timestamps: number[] = [];

      for (const raw of jsonlMessages) {
        const rawMsg = raw as Record<string, unknown>;
        const ts = typeof rawMsg.timestamp === 'string'
          ? new Date(rawMsg.timestamp).getTime() || 0
          : 0;

        const event = mapPersistedClaudeMessage(rawMsg, agentKind ?? 'claude_code');
        if (event) {
          events.push(event as AgentMessage);
          timestamps.push(ts);
        }
      }

      const indexedEvents = applySubagentIndexToEvents(events, subagentIndex);
      if (indexedEvents.changed) {
        events.splice(0, events.length, ...indexedEvents.events);
      }

      const hasResult = events.some((e) => e.kind === 'result');
      if (!hasResult && events.length > 0) {
        // Generate per-turn synthetic result events (for Claude Code historical sessions)
        // Each turn starts with a user message; accumulate usage across assistant messages in the turn.
        let turnStartIdx = -1;
        let turnStartTime = 0;
        const turnResults: Array<{ insertAt: number; result: AgentMessage }> = [];

        for (let i = 0; i < events.length; i++) {
          if (events[i].kind === 'user') {
            // Flush previous turn if it had usage
            if (turnStartIdx >= 0) {
              const turnResult = buildTurnSyntheticResult(events, timestamps, turnStartIdx, i, turnStartTime, sessionId);
              if (turnResult) turnResults.push({ insertAt: turnResult.insertAt, result: turnResult.result });
            }
            turnStartIdx = i;
            turnStartTime = timestamps[i] || 0;
          }
        }
        // Flush last turn
        if (turnStartIdx >= 0) {
          const turnResult = buildTurnSyntheticResult(events, timestamps, turnStartIdx, events.length, turnStartTime, sessionId);
          if (turnResult) turnResults.push({ insertAt: turnResult.insertAt, result: turnResult.result });
        }

        // Insert in reverse order to preserve indices
        for (const tr of turnResults.reverse()) {
          events.splice(tr.insertAt + 1, 0, tr.result);
          timestamps.splice(tr.insertAt + 1, 0, timestamps[tr.insertAt] || 0);
        }

        // Fallback: if no per-turn results were generated, create a single one at the end
        if (turnResults.length === 0) {
          let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
          for (const evt of events) {
            if (evt.kind === 'assistant') {
              const usage = (evt.data as any)?.message?.usage;
              if (usage) {
                totalInput += usage.input_tokens || 0;
                totalOutput += usage.output_tokens || 0;
                totalCacheRead += usage.cache_read_input_tokens || 0;
                totalCacheCreate += usage.cache_creation_input_tokens || 0;
              }
            }
          }
          if (totalInput > 0 || totalOutput > 0) {
            const validTs = timestamps.filter((t) => t > 0);
            events.push({
              kind: 'result',
              data: {
                type: 'result', subtype: 'success', is_error: false,
                uuid: `synthetic-result-${sessionId}`, session_id: sessionId,
                duration_ms: validTs.length >= 2 ? validTs[validTs.length - 1] - validTs[0] : 0,
                duration_api_ms: 0,
                num_turns: events.filter((e) => e.kind === 'user').length,
                result: '', total_cost_usd: 0,
                usage: { input_tokens: totalInput, output_tokens: totalOutput, cache_creation_input_tokens: totalCacheCreate, cache_read_input_tokens: totalCacheRead },
              } as AgentResultMessage,
            });
            timestamps.push(validTs[validTs.length - 1] || 0);
          }
        }
      }

      set((state) => ({
        events: { ...state.events, [sessionId]: events },
        eventTimestamps: { ...state.eventTimestamps, [sessionId]: timestamps },
        todos: { ...state.todos, [sessionId]: extractTodosFromEvents(events) },
        ...(agentKind === 'claude_code'
          ? { subAgentIndex: { ...state.subAgentIndex, [sessionId]: subagentIndex } }
          : {}),
      }));
      logger.info('Loaded session events from agent JSONL', {
        sessionId,
        agentKind: agentKind ?? 'claude_code',
        eventCount: events.length,
      });
    } catch (err) {
      logger.error('Failed to load session messages from agent JSONL', {
        sessionId,
        agentKind: agentKind ?? 'claude_code',
      }, serializeError(err));
    }
  },

  loadSubagentEvents: async (sessionId: string, agentId: string) => {
    const cacheKey = `${sessionId}:${agentId}`;
    // Don't reload if already loaded or loading
    if (get().subAgentEvents[cacheKey] !== undefined || get().subAgentLoading[cacheKey]) {
      return;
    }

    set((state) => ({
      subAgentLoading: { ...state.subAgentLoading, [cacheKey]: true },
    }));

    try {
      const jsonlMessages = await agentApi.loadSubagentSessionEvents(sessionId, agentId);

      if (!jsonlMessages || jsonlMessages.length === 0) {
        logger.info('No sub-agent JSONL history found', { sessionId, agentId });
        // Store empty array to prevent re-fetching
        set((state) => ({
          subAgentEvents: { ...state.subAgentEvents, [cacheKey]: [] },
          subAgentLoading: { ...state.subAgentLoading, [cacheKey]: false },
        }));
        return;
      }

      const events: AgentMessage[] = [];

      for (const raw of jsonlMessages) {
        const rawMsg = raw as Record<string, unknown>;
        const event = mapPersistedClaudeMessage(rawMsg, 'claude_code', { includeSidechain: true });
        if (event) {
          events.push(event as AgentMessage);
        }
      }

      set((state) => ({
        subAgentEvents: { ...state.subAgentEvents, [cacheKey]: events },
        subAgentLoading: { ...state.subAgentLoading, [cacheKey]: false },
      }));
      logger.info('Loaded sub-agent events', { sessionId, agentId, eventCount: events.length });
    } catch (err) {
      logger.error('Failed to load sub-agent events', { sessionId, agentId }, serializeError(err));
      // Store empty array on error to prevent infinite retries
      set((state) => ({
        subAgentEvents: { ...state.subAgentEvents, [cacheKey]: [] },
        subAgentLoading: { ...state.subAgentLoading, [cacheKey]: false },
      }));
    }
  },

  clearChangedFiles: (sessionId: string) => {
    set((state) => {
      const currentFiles = state.changedFiles[sessionId] || [];
      const prevAcknowledged = state.acknowledgedFiles[sessionId] || new Set<string>();
      const newAcknowledged = new Set(prevAcknowledged);
      for (const f of currentFiles) {
        newAcknowledged.add(f.path);
      }
      try {
        localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
      } catch {}
      const newChangedFiles = { ...state.changedFiles };
      delete newChangedFiles[sessionId];
      return {
        changedFiles: newChangedFiles,
        acknowledgedFiles: { ...state.acknowledgedFiles, [sessionId]: newAcknowledged },
      };
    });
  },
}));
