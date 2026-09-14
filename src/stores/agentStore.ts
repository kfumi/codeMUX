import { create } from 'zustand';
import {
  shouldAttachLiveTurn,
  shouldKeepLiveEventsOnHistoryLoad,
  shouldPreferLocalEventsOnHistoryLoad,
} from '../lib/attachToActiveTurn';
import { normalizeTurnProcessEventOrder, normalizeTurnProcessTimeline } from '../lib/agentTurnOrdering';
import { daemonFacade } from '../lib/facades/daemon-facade';
import {
  getLastEventSequence,
  registerDaemonSessionHandler,
  setLastEventSequence,
} from '../lib/daemon-session-bridge';
import { isSteerBlockedPrompt, normalizeImmediateRunMode } from '../lib/agentSteer';
import { supportsCapability } from '../components/agent/agentCapabilities';
import { createLogger, serializeError } from '../lib/logger';
import {
  buildSessionTitleFromUserContent,
} from '../lib/sessionTitle';
import { extractSessionWorkingPathFromEvents, isValidWorkingPath } from '../lib/sessionCwd';
import {
  isClaudeSubagentEvent,
  isClaudeCompactSummaryRawEvent,
  isClaudeCompactSummaryText,
  isClaudeTaskNotificationEvent,
  isCodexCompactSummaryText,
  isAgentInjectedUserMessage,
  isInterruptMarker,
  isTerminalAgentEvent,
  collapsePersistedCompactTimeline,
  mapCodexCompactedEvent,
  mapPersistedClaudeMessage,
  normalizeClaudeUserEvent,
  parseSdkUserMessage,
  shouldProcessTerminalEvent,
  shouldSuppressLiveEventWhileStopped,
  type SessionSummaryEvent,
} from './agentEventParsing';
import { useSessionStore } from './sessionStore';
import { useProjectStore } from './projectStore';
import { normalizeFilePath, usePreviewStore } from './previewStore';
import { useSettingsStore } from './settingsStore';
import { useSubagentStore } from './subagentStore';
import { countDiffLines } from '../lib/diffStats';
import {
  isCodeMuxStreamEvent,
  isCodeMuxToolEvent,
  isCodeMuxAssistantMessageEvent,
  isCodeMuxUserMessageEvent,
  isCodeMuxSystemEvent,
  isCodeMuxDiagnosticEvent,
  isCodeMuxPersistedTimelineEvent,
  isCodeMuxUserInputRequestedEvent,
  isCodeMuxPermissionRequestedEvent,
  isCodeMuxPermissionModeChangedEvent,
  isCodeMuxTurnEvent,
  toLegacyStreamingMessage,
  toLegacyToolMessage,
  toLegacyAssistantMessage,
  toLegacyUserMessage,
  toLegacySystemMessage,
  toLegacyUserInputRequestedMessage,
  toLegacyPermissionRequestedMessage,
  toLegacyPermissionResolvedMessage,
  isCodeMuxPermissionResolvedEvent,
  toLegacyPermissionModeChangedMessage,
  toLegacyTurnMessage,
} from '../lib/codeMuxProtocol';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  AgentPermissionRequest,
  AgentPermissionModeChanged,
  AgentPermissionResponse,
  AgentUserMessageLocator,
  SidecarReadyEvent,
  SidecarErrorEvent,
  SessionResumeFailedEvent,
  TodoItem,
  ChangedFile,
} from '../types/agent';
import type { AgentKind, ReasoningEffort } from '../types/session';
import type { AgentInputPayload, RewindMessageResult, UserAttachmentPreview } from '../types/agentInput';
import type { QueuedAgentQuery } from '../types/agentQueue';
import { markModelVisionUnsupported, resolveVisionCapability, findSessionModelMetadata, isImageRecognitionConfigured } from '../lib/modelVisionCapabilities';
import { getPayloadAttachments, getPayloadImageAttachments, payloadHasAttachments } from '../types/agentInput';
import { countEnrichmentFailures, filterSuccessfulEnrichmentBlocks, firstEnrichmentFailureSummary, mergeEnrichedContext } from '../lib/attachmentEnrichment';
import {
  normalizeThreadTokenUsage,
  type ThreadTokenUsage,
} from '../components/agent/contextUsage';
import { buildConversationTurns } from '../lib/conversationTurns';
import { extractTodosFromEvents } from '../lib/extractTodosFromEvents';
import type { ConversationTurn } from '../types/conversationTurn';

export type AgentMessage =
  | { kind: 'user'; data: { content: string; attachments?: UserAttachmentPreview[]; locator?: AgentUserMessageLocator } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'resume_failed'; data: SessionResumeFailedEvent }
  | { kind: 'stream_status'; data: { message: string; is_reconnecting: boolean; mode_blocked?: ModeBlockedDiagnostic | null } }
  | { kind: 'api_retry'; data: { attempt: number; max_retries: number; retry_delay_ms: number; error_status: number; error: string } }
  | { kind: 'ask_user_question'; data: { tool_use_id: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; value?: unknown }>; multiSelect?: boolean; multiple?: boolean; allowOther?: boolean; presentation?: 'plan-approval'; inputPlaceholder?: string }> } }
  | { kind: 'ask_user_question_timeout'; data: { tool_use_id: string; timeout_ms: number; message: string } }
  | { kind: 'permission'; data: AgentPermissionRequest }
  | { kind: 'permission_resolved'; data: { request_id: string; request_kind: 'permission' | 'question' } }
  | { kind: 'permission_mode_changed'; data: AgentPermissionModeChanged }
  | { kind: 'compact'; data: { compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number; status?: 'compacting' | 'completed'; post_tokens?: number }; subtype: string; type: string } }
  | { kind: 'native_session_rebuilt'; data: { content: string; agent_kind?: string; previous_agent_session_id?: string; agent_session_id?: string } }
  | { kind: 'permission_update_deferred'; data: { content: string; agent_kind?: string } }
  | { kind: 'session_summary'; data: SessionSummaryEvent }
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
  /** Canonical lifecycle model; events remain the assistant-ui compatibility projection. */
  turns: Record<string, ConversationTurn<AgentMessage>[]>;
  /** Timestamps (ms) for each event, recorded at arrival time */
  eventTimestamps: Record<string, number[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** Scheduled/companion turns whose history should keep refreshing while running. */
  backgroundLive: Record<string, boolean>;
  /** When each running query started (ms epoch) — for elapsed timer */
  queryStartTime: Record<string, number>;
  /** Error message if any */
  error: Record<string, string | null>;
  /** Latest MCP runtime status for each session */
  mcpRuntimeStatus: Record<string, string | null>;
  /** Current todos per session (extracted from todowrite / update_plan / Task tools) */
  todos: Record<string, TodoItem[]>;
  /** Latest normalized token/context usage snapshot per session */
  tokenUsageBySession: Record<string, ThreadTokenUsage | null>;
  /** Latest in-flight history usage refresh request id per session */
  tokenUsageRefreshRequests: Record<string, number>;
  /** Accumulated streaming thinking text per session (from stream_event deltas) */
  streamingThinking: Record<string, string>;
  /** Accumulated streaming text per session (from stream_event text deltas) */
  streamingText: Record<string, string>;
  /** 单调递增的实时流版本，滚动逻辑无需订阅长字符串。 */
  streamingVersion: Record<string, number>;
  /**
   * 当前实时思考流开始时的 events 数量快照。之后时间线里若再出现 thinking
   * 提交（索引 >= 快照），说明缓冲区是已提交内容的残留副本；若 thinking
   * 提交都发生在快照之前，则是下一段落的新思考。
   */
  streamingThinkingStartEventCount: Record<string, number>;
  /** Sessions that were force-stopped (interrupt) — suppress streaming UI immediately */
  forceStopped: Record<string, boolean>;
  streamingToolInputs: Record<string, Record<string, string>>;
  streamingToolMeta: Record<string, Record<string, { name: string; index: number }>>;
  streamingToolIndexMap: Record<string, Record<number, string>>;
  streamedToolUseIds: Record<string, Set<string>>;
  changedFiles: Record<string, ChangedFile[]>;
  fileOriginals: Record<string, Record<string, FileOriginalSnapshot>>;
  acknowledgedFiles: Record<string, Set<string>>;
  /** Draft text for each session's composer input (preserved across session switches) */
  composerDrafts: Record<string, string>;
  /** Composer text queued for restoration after a rewind, keyed by session */
  pendingComposerRestore: Record<string, string>;
  /** File/directory reference queued to append to the composer, keyed by session */
  pendingComposerReferenceInsert: Record<string, { reference: string; isDirectory: boolean }>;
  /** Sessions whose history load IPC has completed at least once */
  /** Messages submitted while a turn is active, kept out of provider history until dispatched. */
  queuedQueries: Record<string, QueuedAgentQuery[]>;
  /** Last known working directory per session (includes worktree paths). */
  sessionWorkingPaths: Record<string, string>;
  /** Remember the effective cwd for a session (e.g. worktree path). */
  setSessionWorkingPath: (sessionId: string, cwd: string) => void;
  /** Queue is paused after an interruption or failed dispatch. */
  queuePaused: Record<string, boolean>;
  pendingPermissions: Record<string, AgentPermissionRequest[]>;
  respondToPermission: (sessionId: string, requestId: string, response: AgentPermissionResponse) => Promise<void>;
  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string, reasoningEffort?: ReasoningEffort, displayContent?: string, inputPayload?: AgentInputPayload, modelForVision?: string, fromQueue?: boolean) => Promise<void>;
  /** Interrupt the current query for a specific session */
  interrupt: (sessionId: string) => Promise<void>;
  /** Remove one message from the session queue. */
  removeQueuedQuery: (sessionId: string, queryId: string) => void;
  /** Reorder one message in the session queue. */
  reorderQueuedQuery: (sessionId: string, queryId: string, targetIndex: number) => void;
  /** Resume dispatching queued messages after a stop or failure. */
  resumeQueuedQueries: (sessionId: string) => void;
  /** Interrupt the active turn (if any) and immediately dispatch one queued message ahead of the rest. */
  runQueuedQueryNow: (sessionId: string, queryId: string) => Promise<void>;
  /** Clear all queued messages for a session. */
  clearQueuedQueries: (sessionId: string) => void;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
  /** Store the latest normalized token/context usage snapshot for a session */
  setSessionTokenUsage: (sessionId: string, usage: ThreadTokenUsage | null) => void;
  /** Refresh token/context usage from the agent history file */
  refreshLatestTokenUsage: (sessionId: string, freshness: 'live_synced' | 'restored') => Promise<void>;
  /** Load historical messages for a session */
  loadSessionMessages: (sessionId: string, options?: { force?: boolean }) => Promise<void>;
  /** Attach live stream UI to a session started in the background (e.g. scheduled task). */
  attachToActiveTurn: (sessionId: string, cwd: string, reasoningEffort?: ReasoningEffort) => Promise<boolean>;
  /** Re-attach the daemon WS stream after a page refresh while a turn is still running. */
  attachLiveSession: (sessionId: string) => Promise<boolean>;
  /** Stop the scheduled-turn spinner once history shows the turn has finished. */
  completeBackgroundLiveIfIdle: (sessionId: string) => Promise<void>;
  /** Replace cached timeline with the latest CLI provider history and reload UI state */
  resyncSessionFromNative: (sessionId: string) => Promise<number>;
  /** Clear changed files for a session */
  clearChangedFiles: (sessionId: string) => void;
  /** Save composer draft text for a session */
  saveComposerDraft: (sessionId: string, text: string) => void;
  /** Get and clear composer draft text for a session */
  consumeComposerDraft: (sessionId: string) => string;
  /** Get composer draft text without clearing it */
  getComposerDraft: (sessionId: string) => string;
  /** Rewind the latest user turn and prepare its payload for composer editing */
  rewindLastTurn: (sessionId: string) => Promise<RewindMessageResult | null>;
  /** Rewind to an arbitrary historical user message by its event index and prepare its payload for composer editing */
  rewindToMessage: (sessionId: string, userEventIndex: number, mode?: RewindMode) => Promise<RewindMessageResult | null>;
  /** Queue composer text to be restored for a session (applied only when the composer is empty) */
  requestComposerRestore: (sessionId: string, text: string) => void;
  /** Consume and clear any pending composer restore text for a session */
  clearComposerRestore: (sessionId: string) => void;
  /** Queue a file/directory reference to append to the composer for a session */
  requestComposerReferenceInsert: (sessionId: string, reference: string, isDirectory?: boolean) => void;
  /** Consume and clear any pending composer reference insert for a session */
  clearComposerReferenceInsert: (sessionId: string) => void;
}

type StreamingBuffer = {
  thinking: string;
  text: string;
};

// Leading-edge + coalesce: first delta paints immediately; later deltas
// coalesce into at most one flush per throttle window for UI smoothness.
// 与 sidecar 的 50ms stream batch 对齐，避免再次拆分 transport batch。
const STREAMING_FLUSH_THROTTLE_MS = 50;
// Claude Code can emit substantially more partial events than the other
// runtimes. A trailing-only preview keeps the UI responsive while retaining
// a visibly live stream.
const CLAUDE_STREAMING_FLUSH_THROTTLE_MS = 100;
// 实时预览只需要展示最新内容，完整 thinking 由最终 assistant event 保存。
const STREAMING_PREVIEW_MAX_CHARS = 16_384;
const logger = createLogger('agentStore');
const pendingStreamingBuffers = new Map<string, StreamingBuffer>();
const pendingStreamingFlushHandles = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSessionMessageLoads = new Map<string, Promise<void>>();
const sessionHistoryEpoch = new Map<string, number>();
const backgroundPolls = new Map<string, number>();

function stopBackgroundPoll(sessionId: string) {
  const timer = backgroundPolls.get(sessionId);
  if (timer) window.clearInterval(timer);
  backgroundPolls.delete(sessionId);
}

function bumpSessionHistoryEpoch(sessionId: string): number {
  const next = (sessionHistoryEpoch.get(sessionId) ?? 0) + 1;
  sessionHistoryEpoch.set(sessionId, next);
  return next;
}

function getSessionHistoryEpoch(sessionId: string): number {
  return sessionHistoryEpoch.get(sessionId) ?? 0;
}

const sessionsWithLiveTextStream = new Set<string>();
/** Per-session live stream phase. OpenCode often emits reasoning as text_delta;
 * keep content in the reasoning panel until we explicitly enter the answer phase. */
const sessionStreamPhase = new Map<string, 'thinking' | 'answer'>();
const streamingTelemetry = new Map<string, { deltas: number; flushes: number; uiUpdates: number }>();

const INTERRUPT_DRAIN_TIMEOUT_MS = 30_000;
const interruptDrains = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function beginInterruptDrain(sessionId: string): void {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  interruptDrains.set(sessionId, { promise, resolve });
}

function resolveInterruptDrain(sessionId: string): void {
  const entry = interruptDrains.get(sessionId);
  if (!entry) {
    return;
  }
  entry.resolve();
  interruptDrains.delete(sessionId);
}

async function waitForInterruptDrain(sessionId: string): Promise<void> {
  const entry = interruptDrains.get(sessionId);
  if (!entry) {
    return;
  }
  await Promise.race([
    entry.promise,
    new Promise<void>((resolve) => setTimeout(resolve, INTERRUPT_DRAIN_TIMEOUT_MS)),
  ]);
  interruptDrains.delete(sessionId);
}

function enqueuePendingPermission(
  pendingPermissions: Record<string, AgentPermissionRequest[]>,
  sessionId: string,
  request: AgentPermissionRequest,
): Record<string, AgentPermissionRequest[]> {
  const current = pendingPermissions[sessionId] ?? [];
  const existingIndex = current.findIndex((item) => item.request_id === request.request_id);
  const next = existingIndex === -1
    ? [...current, request]
    : current.map((item, index) => index === existingIndex ? request : item);
  return { ...pendingPermissions, [sessionId]: next };
}

/**
 * Issue 12: drop a pending permission approval when another surface (Mobile
 * Companion) resolved it — the broadcast `permission_resolved` event is the
 * single source of truth for either client.
 */
function dequeueResolvedPermission(
  pendingPermissions: Record<string, AgentPermissionRequest[]>,
  sessionId: string,
  requestId: string,
): Record<string, AgentPermissionRequest[]> {
  const current = pendingPermissions[sessionId] ?? [];
  if (!current.some((item) => item.request_id === requestId)) {
    return pendingPermissions;
  }
  return { ...pendingPermissions, [sessionId]: current.filter((item) => item.request_id !== requestId) };
}

function getSessionStreamPhase(sessionId: string): 'thinking' | 'answer' {
  return sessionStreamPhase.get(sessionId) ?? 'thinking';
}

function setSessionStreamPhase(sessionId: string, phase: 'thinking' | 'answer') {
  sessionStreamPhase.set(sessionId, phase);
}

function resetSessionStreamPhase(sessionId: string) {
  sessionStreamPhase.delete(sessionId);
}

function scheduleStreamingFlush(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
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

function appendStreamingPreview(previous: string, chunk: string): string {
  if (!previous) {
    return chunk.length > STREAMING_PREVIEW_MAX_CHARS
      ? chunk.slice(-STREAMING_PREVIEW_MAX_CHARS)
      : chunk;
  }

  if (previous.length + chunk.length <= STREAMING_PREVIEW_MAX_CHARS) {
    return previous + chunk;
  }

  if (chunk.length >= STREAMING_PREVIEW_MAX_CHARS) {
    return chunk.slice(-STREAMING_PREVIEW_MAX_CHARS);
  }

  return `${previous.slice(-(STREAMING_PREVIEW_MAX_CHARS - chunk.length))}${chunk}`;
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
    let nextTextPreview = state.streamingText[sessionId] || '';

    if (buffer.thinking) {
      updates.streamingThinking = {
        ...state.streamingThinking,
        [sessionId]: appendStreamingPreview(state.streamingThinking[sessionId] || '', buffer.thinking),
      };
    }

    if (buffer.text) {
      nextTextPreview = appendStreamingPreview(nextTextPreview, buffer.text);
      updates.streamingText = {
        ...state.streamingText,
        [sessionId]: nextTextPreview,
      };
    }

    updates.streamingVersion = {
      ...state.streamingVersion,
      [sessionId]: (state.streamingVersion[sessionId] ?? 0) + 1,
    };

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

/**
 * Splices `incoming` over the most recent event accepted by `matches`,
 * scanning backwards; appends when no replaceable placeholder exists.
 * Keeps single-placeholder markers (reconnecting status, compacting hint)
 * from stacking duplicates.
 */
function replaceLastOrAppend(
  events: AgentMessage[],
  incoming: AgentMessage,
  matches: (entry: AgentMessage) => boolean,
): AgentMessage[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (matches(events[i])) {
      return [...events.slice(0, i), incoming, ...events.slice(i + 1)];
    }
  }
  return [...events, incoming];
}

function isNarrationOnlyAssistantEvent(
  event: AgentMessage,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block: { type?: string; text?: string }) => (
    block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  ));
}

/**
 * 是否为"延续流式 narration"的最终 assistant 消息：同时含 thinking 与 text、
 * 无工具块（pi 等运行时把思考与回答合成一条最终消息）。这类事件到达时应原地
 * 替换正在流式预览的 narration 事件，或追加到工具步骤之后，而不是插到 pending tools 前。
 */
function isNarrationContinuationAssistantEvent(
  event: AgentMessage,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  let hasText = false;
  let hasThinking = false;
  const allAllowed = content.every((block: { type?: string; text?: string; thinking?: string }) => {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      hasText = true;
      return true;
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
      hasThinking = true;
      return true;
    }
    return false;
  });
  return allAllowed && hasText && hasThinking;
}

function hasToolOnlyAssistantAfterIndex(events: AgentMessage[], index: number): boolean {
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event?.kind === 'user') {
      return false;
    }
    if (isToolOnlyAssistantEvent(event)) {
      return true;
    }
  }
  return false;
}

function textFromNarrationOnlyAssistantEvent(event: AgentMessage): string | undefined {
  if (!isNarrationOnlyAssistantEvent(event)) {
    return undefined;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text : ''))
    .join('');
  return text.trim().length > 0 ? text : undefined;
}

function appendPiNarrationFinalAfterTools(
  baseEvents: AgentMessage[],
  event: Extract<AgentMessage, { kind: 'assistant' }>,
  sessionId: string,
): AgentMessage[] {
  const narrationText = textFromNarrationOnlyAssistantEvent(event);
  const replaceAt = narrationText != null
    ? findReplaceableLiveNarrationIndex(baseEvents, narrationText, sessionId)
    : undefined;

  if (replaceAt != null) {
    return baseEvents.map((entry, index) => (index === replaceAt ? event : entry));
  }

  return [
    ...stripEphemeralLiveStreamNarrationEvents(baseEvents),
    event,
  ];
}

function insertPiProcessEventBeforeTrailingNarration(
  baseEvents: AgentMessage[],
  event: AgentMessage,
  sessionId: string,
): AgentMessage[] {
  if (getSessionAgentKind(sessionId) !== 'pi') {
    return [...baseEvents, event];
  }

  if (event.kind !== 'assistant' || !isToolOnlyAssistantEvent(event)) {
    if (event.kind !== 'tool_result') {
      return [...baseEvents, event];
    }
  }

  for (let index = baseEvents.length - 1; index >= 0; index -= 1) {
    const candidate = baseEvents[index];
    if (candidate?.kind === 'tool_result') {
      continue;
    }
    if (candidate?.kind !== 'assistant') {
      break;
    }
    if (isToolOnlyAssistantEvent(candidate)) {
      continue;
    }
    if (isNarrationOnlyAssistantEvent(candidate) || isNarrationContinuationAssistantEvent(candidate)) {
      return [...baseEvents.slice(0, index), event, ...baseEvents.slice(index)];
    }
    break;
  }

  return [...baseEvents, event];
}

function appendPiContinuationAssistantMessage(
  baseEvents: AgentMessage[],
  event: Extract<AgentMessage, { kind: 'assistant' }>,
  sessionId: string,
): AgentMessage[] {
  const narrationText = narrationTextFromAssistantEvent(event);
  const replaceAt = narrationText != null
    ? findReplaceableLiveNarrationIndex(baseEvents, narrationText, sessionId)
    : undefined;
  const canReplaceInPlace = replaceAt != null
    && !hasToolOnlyAssistantAfterIndex(baseEvents, replaceAt);

  if (canReplaceInPlace) {
    return baseEvents.map((entry, index) => (index === replaceAt ? event : entry));
  }

  const cleaned = baseEvents.filter((entry, index) => (
    index !== replaceAt && !isLiveStreamNarrationEvent(entry, sessionId)
  ));
  return [...cleaned, event];
}

function isToolOnlyAssistantEvent(
  event: AgentMessage,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block: { type?: string }) => block?.type === 'tool_use');
}

function narrationTextFromAssistantEvent(event: AgentMessage): string | undefined {
  if (!isNarrationContinuationAssistantEvent(event)) {
    return undefined;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text : ''))
    .join('');
  return text.trim().length > 0 ? text : undefined;
}

function findNarrationAssistantInsertionIndex(events: AgentMessage[]): number | undefined {
  let insertAt: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'tool_result') {
      continue;
    }
    if (event?.kind !== 'assistant') {
      break;
    }
    if (!isToolOnlyAssistantEvent(event)) {
      break;
    }
    insertAt = index;
  }
  return insertAt;
}

function findReplaceableLiveNarrationIndex(
  events: AgentMessage[],
  text: string,
  sessionId: string,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'tool_result') {
      continue;
    }
    if (event?.kind !== 'assistant') {
      break;
    }
    if (isLiveStreamNarrationEvent(event, sessionId)) {
      return index;
    }
    if (isToolOnlyAssistantEvent(event)) {
      continue;
    }
    if (isNarrationOnlyAssistantEvent(event)) {
      const existingText = narrationTextFromAssistantEvent(event);
      if (
        existingText
        && (
          existingText === text
          || existingText.startsWith(text)
          || text.startsWith(existingText)
        )
      ) {
        return index;
      }
      break;
    }
    break;
  }
  return undefined;
}

function commitLiveStreamingNarration(
  sessionId: string,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  get: () => AgentState,
): boolean {
  flushPendingStreaming(sessionId, set);
  const prev = get().events[sessionId] || [];
  const liveIndex = prev.findIndex((entry) => isLiveStreamNarrationEvent(entry, sessionId));
  if (liveIndex >= 0) {
    set((state) => ({
      streamingText: { ...state.streamingText, [sessionId]: '' },
      streamingVersion: {
        ...state.streamingVersion,
        [sessionId]: (state.streamingVersion[sessionId] ?? 0) + 1,
      },
    }));
    sessionsWithLiveTextStream.delete(sessionId);
    return true;
  }

  const text = get().streamingText[sessionId]?.trim();
  if (!text) {
    return false;
  }

  const now = Date.now();
  const event: AgentMessage = {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: liveStreamNarrationUuid(sessionId),
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
    },
  };

  set((state) => ({
    events: {
      ...state.events,
      [sessionId]: [...(state.events[sessionId] || []), event],
    },
    eventTimestamps: {
      ...state.eventTimestamps,
      [sessionId]: [...(state.eventTimestamps[sessionId] || []), now],
    },
    streamingText: { ...state.streamingText, [sessionId]: '' },
    streamingVersion: {
      ...state.streamingVersion,
      [sessionId]: (state.streamingVersion[sessionId] ?? 0) + 1,
    },
  }));
  sessionsWithLiveTextStream.delete(sessionId);
  return true;
}

const LIVE_STREAM_NARRATION_UUID_PREFIX = 'live-stream-narration:';

export function isEphemeralLiveStreamNarrationEvent(event: AgentMessage): boolean {
  return event.kind === 'assistant'
    && typeof event.data?.uuid === 'string'
    && event.data.uuid.startsWith(LIVE_STREAM_NARRATION_UUID_PREFIX);
}

function liveStreamNarrationUuid(sessionId: string): string {
  return `${LIVE_STREAM_NARRATION_UUID_PREFIX}${sessionId}`;
}

function isLiveStreamNarrationEvent(event: AgentMessage, sessionId: string): boolean {
  return event.kind === 'assistant'
    && isEphemeralLiveStreamNarrationEvent(event)
    && event.data?.uuid === liveStreamNarrationUuid(sessionId);
}

function stripEphemeralLiveStreamNarrationEvents(events: AgentMessage[]): AgentMessage[] {
  return events.filter((entry) => !isEphemeralLiveStreamNarrationEvent(entry));
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

  const isClaude = getSessionAgentKind(sessionId) === 'claude_code';
  const flushDelayMs = isClaude ? CLAUDE_STREAMING_FLUSH_THROTTLE_MS : STREAMING_FLUSH_THROTTLE_MS;

  // Claude's SDK can deliver several transport batches inside a render frame.
  // Use a trailing flush there so one batch cannot cause both an immediate and
  // a delayed React commit. Other runtimes retain the leading-edge behavior.
  if (!pendingStreamingFlushHandles.has(sessionId)) {
    const handle = scheduleStreamingFlush(() => {
      pendingStreamingFlushHandles.delete(sessionId);
      const pending = pendingStreamingBuffers.get(sessionId);
      if (!pending) {
        return;
      }

      pendingStreamingBuffers.delete(sessionId);
      recordStreamingTelemetry(sessionId, 'flushes');
      applyStreamingBuffer(sessionId, pending, set);
    }, flushDelayMs);
    pendingStreamingFlushHandles.set(sessionId, handle);

    if (!isClaude) {
      recordStreamingTelemetry(sessionId, 'flushes');
      recordStreamingTelemetry(sessionId, 'uiUpdates');
      pendingStreamingBuffers.delete(sessionId);
      applyStreamingBuffer(sessionId, { thinking: key === 'thinking' ? chunk : '', text: key === 'text' ? chunk : '' }, set);
      pendingStreamingBuffers.set(sessionId, { thinking: '', text: '' });
    } else {
      pendingStreamingBuffers.set(sessionId, {
        thinking: key === 'thinking' ? chunk : '',
        text: key === 'text' ? chunk : '',
      });
    }
    return;
  }

  const buffer = pendingStreamingBuffers.get(sessionId) ?? { thinking: '', text: '' };
  buffer[key] += chunk;
  pendingStreamingBuffers.set(sessionId, buffer);
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

function simulateStreamingContent(
  sessionId: string,
  event: AgentMessage,
  chunks: Array<{ key: keyof StreamingBuffer; text: string }>,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
) {
  clearSimulatedStream(sessionId);

  set((s) => ({
    streamingText: { ...s.streamingText, [sessionId]: '' },
    streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
  }));

  const queue: Array<{ key: keyof StreamingBuffer; remaining: string }> = chunks
    .filter((chunk) => chunk.text.length > 0)
    .map((chunk) => ({ key: chunk.key, remaining: chunk.text }));

  if (queue.length === 0) {
    set((s) => {
      const prev = s.events[sessionId] || [];
      const timestamps = s.eventTimestamps[sessionId] || [];
      return {
        events: { ...s.events, [sessionId]: [...prev, event] },
        eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...timestamps, Date.now()] },
      };
    });
    return;
  }

  const entry: SimulatedStreamEntry = {
    event,
    remaining: queue.map((item) => item.remaining).join(''),
    timer: 0,
  };
  // Stash queue on entry via closure
  pendingSimulatedStreams.set(sessionId, entry);

  const tick = () => {
    const current = pendingSimulatedStreams.get(sessionId);
    if (!current || current !== entry) return;

    while (queue.length > 0 && !queue[0].remaining) {
      queue.shift();
    }

    if (queue.length === 0) {
      pendingSimulatedStreams.delete(sessionId);
      clearPendingStreaming(sessionId);
      set((s) => {
        const prev = s.events[sessionId] || [];
        const timestamps = s.eventTimestamps[sessionId] || [];
        return {
          events: { ...s.events, [sessionId]: [...prev, current.event] },
          eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...timestamps, Date.now()] },
          streamingText: { ...s.streamingText, [sessionId]: '' },
          streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
        };
      });
      return;
    }

    const active = queue[0];
    const size = Math.min(SIM_CHARS_PER_TICK, active.remaining.length);
    const chunk = active.remaining.slice(0, size);
    active.remaining = active.remaining.slice(size);
    current.remaining = queue.map((item) => item.remaining).join('');

    queueStreamingDelta(sessionId, active.key, chunk, set);
    current.timer = window.setTimeout(tick, SIM_TICK_MS);
  };

  entry.timer = window.setTimeout(tick, 30);
}

export function parseAgentEvent(raw: string): AgentMessage {
  try {
    const data = JSON.parse(raw);

    // Filter out sub-agent (sidechain) messages from the main event stream.
    if (isClaudeSubagentEvent(data)) {
      return { kind: 'raw', data };
    }

    if (isClaudeTaskNotificationEvent(data)) {
      return { kind: 'raw', data };
    }

    const codexCompactedEvent = mapCodexCompactedEvent(data);
    if (codexCompactedEvent) {
      return codexCompactedEvent;
    }

    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'session_resume_failed':
        return { kind: 'resume_failed', data };
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
        if (isAssistantCompactSummaryEvent(data)) {
          return { kind: 'raw', data };
        }
        return { kind: 'assistant', data };
      case 'user':
        {
          const event = parseSdkUserMessage(data);
          if (event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)) {
            return { kind: 'raw', data };
          }
          if (event.kind === 'user') {
            if (
              data.isMeta === true ||
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
      case 'permission':
        if (typeof data.request_id !== 'string' || typeof data.permission_type !== 'string') return { kind: 'raw', data };
        return { kind: 'permission', data: { request_id: data.request_id, permission_id: typeof data.permission_id === 'string' ? data.permission_id : undefined, permission_type: data.permission_type, description: typeof data.description === 'string' ? data.description : data.permission_type, metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : undefined } };
      case 'ask_user_question_timeout':
        return { kind: 'ask_user_question_timeout', data };
      case 'file_snapshot':
        return { kind: 'file_snapshot', data };
      case 'stream_event':
        return { kind: 'streaming', data: { event: data.event, session_id: data.session_id } };
      case 'stream_event_batch':
        return { kind: 'streaming_batch', data: { events: Array.isArray(data.events) ? data.events : [], session_id: data.session_id } };
      case 'codemux_event_batch': {
        const codeMuxEvents = Array.isArray(data.events)
          ? (data.events as unknown[]).filter(isCodeMuxStreamEvent)
          : [];
        const events = codeMuxEvents.flatMap((event) => {
          const legacy = toLegacyStreamingMessage(event);
          return legacy.kind === 'streaming' ? [legacy.data.event] : [];
        });
        return { kind: 'streaming_batch', data: { events, session_id: data.session_id } };
      }
      case 'content_started':
      case 'text_delta':
      case 'reasoning_delta':
      case 'content_finished':
        if (isCodeMuxStreamEvent(data)) return toLegacyStreamingMessage(data);
        return { kind: 'raw', data };
      case 'tool_started':
      case 'tool_finished':
        if (isCodeMuxToolEvent(data)) return toLegacyToolMessage(data);
        return { kind: 'raw', data };
      case 'assistant_message':
        if (isCodeMuxAssistantMessageEvent(data)) {
          const event = toLegacyAssistantMessage(data);
          return event.kind === 'assistant' && isAssistantCompactSummaryEvent(event.data as unknown as Record<string, unknown>)
            ? { kind: 'raw', data }
            : event;
        }
        return { kind: 'raw', data };
      case 'user_message':
        if (isCodeMuxUserMessageEvent(data)) {
          const event = toLegacyUserMessage(data);
          return event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)
            ? { kind: 'raw', data }
            : event;
        }
        return { kind: 'raw', data };
      case 'system_event':
        if (isCodeMuxSystemEvent(data)) return toLegacySystemMessage(data);
        return { kind: 'raw', data };
      case 'diagnostic':
        if (isCodeMuxDiagnosticEvent(data)) return { kind: 'raw', data };
        return { kind: 'raw', data };
      case 'user_input_requested':
        if (isCodeMuxUserInputRequestedEvent(data)) return toLegacyUserInputRequestedMessage(data);
        return { kind: 'raw', data };
      case 'permission_requested':
        if (isCodeMuxPermissionRequestedEvent(data)) return toLegacyPermissionRequestedMessage(data);
        return { kind: 'raw', data };
      case 'permission_resolved':
        if (isCodeMuxPermissionResolvedEvent(data)) return toLegacyPermissionResolvedMessage(data);
        return { kind: 'raw', data };
      case 'permission_mode_changed':
        if (isCodeMuxPermissionModeChangedEvent(data)) return toLegacyPermissionModeChangedMessage(data);
        return { kind: 'raw', data };
      case 'error':
      case 'turn_finished':
        if (isCodeMuxTurnEvent(data)) return toLegacyTurnMessage(data);
        return { kind: 'raw', data };
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

function isModeBlockedDiagnostic(value: unknown): value is ModeBlockedDiagnostic {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAssistantCompactSummaryEvent(data: Record<string, unknown>): boolean {
  const message = data.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return isCodexCompactSummaryText(content);
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const text = (block as Record<string, unknown>).text;
    return typeof text === 'string' && isCodexCompactSummaryText(text);
  });
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

/** Static rewind capability declaration per agent kind (files/both reserved for a later phase). */
export type RewindMode = 'conversation' | 'files' | 'both';

export const AGENT_REWIND_CAPABILITIES: Record<AgentKind, {
  conversation: boolean;
  files: boolean;
  both: boolean;
}> = {
  claude_code: { conversation: true, files: true, both: true },
  codex: { conversation: true, files: false, both: false },
  gemini_cli: { conversation: false, files: false, both: false },
  opencode: { conversation: true, files: false, both: false },
  // pi 经 sidecar 原生 fork 实现会话树 rewind（无文件快照，不支持 files/both）。
  pi: { conversation: true, files: false, both: false },
};

export function supportsRewindMode(agentKind: AgentKind | undefined, mode: RewindMode): boolean {
  if (!agentKind) {
    return false;
  }
  return AGENT_REWIND_CAPABILITIES[agentKind][mode];
}

function hasCurrentTurnCommittedThinking(events: AgentMessage[]): boolean {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  for (let i = lastUserIdx + 1; i < events.length; i += 1) {
    const evt = events[i];
    if (evt?.kind !== 'assistant') continue;
    const content = evt.data?.message?.content || [];
    if (content.some((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0)) {
      return true;
    }
  }
  return false;
}

function isOpencodeLikeAgent(sessionId: string): boolean {
  const kind = getSessionAgentKind(sessionId);
  return kind === 'opencode';
}

export function isRewindableUserEvent(event: AgentMessage): event is Extract<AgentMessage, { kind: 'user' }> {
  if (event.kind !== 'user') {
    return false;
  }
  if (isInterruptMarker(event.data.content)) {
    return false;
  }
  return event.data.content.trim().length > 0 || (event.data.attachments?.length ?? 0) > 0;
}

function getRewindableUserIndex(events: AgentMessage[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isRewindableUserEvent(event)) {
      return index;
    }
  }

  return -1;
}

function buildInputPayloadFromUserEvent(event: Extract<AgentMessage, { kind: 'user' }>): AgentInputPayload {
  const images = event.data.attachments?.map((attachment) => ({
    name: attachment.name,
    mediaType: attachment.mediaType,
    dataUrl: attachment.dataUrl,
  }));

  return images && images.length > 0
    ? { text: event.data.content, images }
    : { text: event.data.content };
}

export function hasStrongRewindLocator(locator: AgentUserMessageLocator | undefined): boolean {
  return Boolean(
    locator?.providerMessageId?.trim()
    || typeof locator?.lineIndex === 'number'
    || typeof locator?.sourceEventIndex === 'number',
  );
}

function isMissingRewindTargetError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String((error as { message?: unknown })?.message ?? error);
  return /Target rewind user message not found/i.test(message);
}

function removeSessionEntry<T>(record: Record<string, T>, sessionId: string): Record<string, T> {
  const { [sessionId]: _removed, ...rest } = record;
  return rest;
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

      const toolName = block.name.toLowerCase();

      if (toolName === 'write') {
        const rawPath = (input?.file_path ?? input?.filePath) as string;
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

      if (toolName === 'edit') {
        const rawPath = (input?.file_path ?? input?.filePath) as string;
        const oldString = (input?.old_string ?? input?.oldString) as string;
        const newString = (input?.new_string ?? input?.newString) as string;
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

const SESSION_WORKING_PATHS_KEY = 'codemux-session-working-paths';

function loadSessionWorkingPaths(): Record<string, string> {
  if (typeof localStorage === 'undefined') {
    return {};
  }

  try {
    const raw = localStorage.getItem(SESSION_WORKING_PATHS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string'
          && typeof entry[1] === 'string'
          && entry[1].trim().length > 0
        )),
    );
  } catch {
    return {};
  }
}

function persistSessionWorkingPaths(paths: Record<string, string>): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(SESSION_WORKING_PATHS_KEY, JSON.stringify(paths));
  } catch {
    // ignore quota errors
  }
}

function updateSessionWorkingPaths(
  paths: Record<string, string>,
  sessionId: string,
  cwd: string,
): Record<string, string> {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return paths;
  }

  const next = { ...paths, [sessionId]: trimmed };
  persistSessionWorkingPaths(next);
  return next;
}

export const useAgentStore = create<AgentState>((set, get) => {
  const queuedDispatches = new Map<string, Promise<void>>();
  const inflightSteerRequests = new Map<string, { sessionId: string; query: QueuedAgentQuery }>();

  const createQueuedQuery = (
    prompt: string,
    cwd: string,
    reasoningEffort?: ReasoningEffort,
    displayContent?: string,
    inputPayload?: AgentInputPayload,
    modelForVision?: string,
  ): QueuedAgentQuery => ({
    id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    prompt,
    cwd,
    reasoningEffort,
    displayContent,
    inputPayload,
    modelForVision,
    createdAt: Date.now(),
  });

  const dispatchNextQueuedQuery = (sessionId: string): void => {
    if (queuedDispatches.has(sessionId)) {
      return;
    }

    const dispatch = Promise.resolve().then(async () => {
      const state = get();
      if (state.isRunning[sessionId] || state.queuePaused[sessionId]) {
        return;
      }

      const next = state.queuedQueries[sessionId]?.[0];
      if (!next) {
        return;
      }

      set((current) => ({
        queuedQueries: {
          ...current.queuedQueries,
          [sessionId]: (current.queuedQueries[sessionId] ?? []).slice(1),
        },
      }));

      try {
        await get().startQuery(
          sessionId,
          next.prompt,
          next.cwd,
          next.reasoningEffort,
          next.displayContent,
          next.inputPayload,
          next.modelForVision,
          true,
        );
      } catch (error) {
        logger.error('Failed to dispatch queued agent query', { sessionId, queryId: next.id }, serializeError(error));
        set((current) => ({
          queuedQueries: {
            ...current.queuedQueries,
            [sessionId]: [next, ...(current.queuedQueries[sessionId] ?? [])],
          },
          queuePaused: { ...current.queuePaused, [sessionId]: true },
        }));
      }
    });

    queuedDispatches.set(sessionId, dispatch);
    void dispatch.finally(() => {
      if (queuedDispatches.get(sessionId) === dispatch) {
        queuedDispatches.delete(sessionId);
        const state = get();
        if (
          !state.isRunning[sessionId]
          && !state.queuePaused[sessionId]
          && (state.queuedQueries[sessionId]?.length ?? 0) > 0
        ) {
          dispatchNextQueuedQuery(sessionId);
        }
      }
    });
  };

  const consumeSteerResultEvent = (
    raw: string,
    onUnavailable: (sessionId: string, query: QueuedAgentQuery) => void,
  ): boolean => {
    try {
      const data = JSON.parse(raw) as {
        type?: string;
        request_id?: string;
        ok?: boolean;
      };
      if (data.type !== 'steer_result' || typeof data.request_id !== 'string') {
        return false;
      }
      const pending = inflightSteerRequests.get(data.request_id);
      inflightSteerRequests.delete(data.request_id);
      if (pending && data.ok !== true) {
        onUnavailable(pending.sessionId, pending.query);
      }
      return true;
    } catch {
      return false;
    }
  };

  const interruptAndRunQueuedQuery = async (sessionId: string, queryId: string) => {
    const queue = get().queuedQueries[sessionId] ?? [];
    if (!queue.some((query) => query.id === queryId)) {
      return;
    }

    get().reorderQueuedQuery(sessionId, queryId, 0);

    const wasRunning = get().isRunning[sessionId] ?? false;
    await get().interrupt(sessionId);
    if (wasRunning) {
      await waitForInterruptDrain(sessionId);
    }
    get().resumeQueuedQueries(sessionId);
  };

  const restoreQueuedQueryAtFront = (sessionId: string, query: QueuedAgentQuery) => {
    set((state) => {
      const current = state.queuedQueries[sessionId] ?? [];
      if (current.some((item) => item.id === query.id)) {
        return state;
      }
      return {
        queuedQueries: {
          ...state.queuedQueries,
          [sessionId]: [query, ...current],
        },
      };
    });
  };

  const fallbackQueuedQueryNow = (sessionId: string, query: QueuedAgentQuery) => {
    restoreQueuedQueryAtFront(sessionId, query);
    void interruptAndRunQueuedQuery(sessionId, query.id);
  };

function createSessionEventHandler(
  sessionId: string,
  get: () => AgentState,
  set: (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void,
  visionModel: string | null | undefined,
): (raw: string) => void {
  // 活跃判定动态读 store 而非捕获时间戳:同一 handler 要同时服务“发送消息”与
  // “重新附着进行中回合”两条路径,新一轮会把 queryStartTime 换成新值。
  const isActiveQuery = () => get().queryStartTime[sessionId] != null;
  return (raw: string) => {
    // Subagent tracks are routed to their own store and never enter the
    // parent timeline events.
    if (useSubagentStore.getState().routeSubagentSidecarEvent(raw, sessionId)) {
      return;
    }
    if (consumeSteerResultEvent(raw, (failedSessionId, query) => {
      void fallbackQueuedQueryNow(failedSessionId, query);
    })) {
      return;
    }
    let event = parseAgentEvent(raw);
    const now = Date.now();
    const forceStoppedNow = get().forceStopped[sessionId] ?? false;
    if (forceStoppedNow && (event.kind === 'done' || event.kind === 'error')) {
      resolveInterruptDrain(sessionId);
    }

    if (event.kind === 'resume_failed') {
      if (!isActiveQuery()) {
        return;
      }
      const message = `外部会话恢复失败，已切换为只读快照：${event.data.error}`;
      void useSessionStore.getState().setSessionReadOnly(sessionId, true).catch((error) => {
        logger.error('Failed to persist imported session read-only state', { sessionId }, serializeError(error));
      });
      clearPendingStreaming(sessionId);
      clearPendingStreamingToolInputs(sessionId);
      set((s) => ({
        isRunning: { ...s.isRunning, [sessionId]: false },
        error: { ...s.error, [sessionId]: message },
        queryStartTime: Object.fromEntries(Object.entries(s.queryStartTime).filter(([id]) => id !== sessionId)),
      }));
      useSessionStore.getState().markSessionUnread(sessionId);
      return;
    }

    // Skip sub-agent (sidechain) messages from the main thread.
    if (event.kind === 'raw' && isClaudeSubagentEvent(event.data)) {
      return;
    }

    if (event.kind === 'raw' && event.data?.type === 'vision_unsupported') {
      markModelVisionUnsupported(typeof event.data.model === 'string' ? event.data.model : visionModel);
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

    // The Sidecar now emits the canonical user_message event. Keep the
    // optimistic local message and discard its wire echo once it arrives.
    if (event.kind === 'user') {
      const previousEvents = get().events[sessionId] || [];
      const lastUserEvent = [...previousEvents].reverse().find((existingEvent) => existingEvent.kind === 'user');
      if (lastUserEvent?.kind === 'user' && lastUserEvent.data.content === event.data.content) {
        return;
      }
    }

    if (event.kind === 'raw' && event.data?.type === 'sidecar_debug') {
      return;
    }

    if (event.kind === 'raw' && event.data?.type === 'token_usage_update') {
      return;
    }

    if (event.kind === 'permission_mode_changed') {
      const planMode = (event as Extract<AgentMessage, { kind: 'permission_mode_changed' }>).data.plan_mode;
      // 先更新本地会话投影，原生模式事件到达后下拉立即反映当前模式。
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId
          ? { ...session, plan_mode: planMode }
          : session),
      }));
      void useSessionStore.getState().updateSessionPermissions(sessionId, undefined, planMode).catch((error) => {
        logger.warn('Failed to persist Claude plan mode change', { sessionId, planMode }, serializeError(error));
      });
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

    // Side-band runtime status (compat proxy indicator): never enters the
    // message timeline.
    if (event.kind === 'proxy_status') {
      const localUrl = event.data.running && event.data.port
        ? `http://127.0.0.1:${event.data.port}`
        : null;
      useSettingsStore.getState().setProxyRunning(event.data.running, localUrl);
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
            logger.debug('Thinking block started', { sessionId });
            setSessionStreamPhase(sessionId, 'thinking');
            flushPendingStreaming(sessionId, set);
            clearStreamingTextField(sessionId, 'streamingThinking', set, get);
            // 记录本段思考流起点：时间线中若之后才出现 thinking 提交，说明
            // 实时缓冲是已提交内容的残留；否则是下一段落的新思考。
            set((s) => ({
              streamingThinkingStartEventCount: {
                ...s.streamingThinkingStartEventCount,
                [sessionId]: (s.events[sessionId] || []).length,
              },
            }));
          } else if (contentBlock?.type === 'text') {
            logger.debug('Text block started', { sessionId });
            flushPendingStreaming(sessionId, set);
            const hasThinkingContent = Boolean(get().streamingThinking[sessionId]);
            const hasCommittedThinking = hasCurrentTurnCommittedThinking(get().events[sessionId] || []);
            if (
              !isOpencodeLikeAgent(sessionId)
              || hasThinkingContent
              || hasCommittedThinking
              || getSessionStreamPhase(sessionId) === 'answer'
            ) {
              setSessionStreamPhase(sessionId, 'answer');
              // Pi 等运行时在最终 assistant_message 到达前不会把思考写入事件；
              // 进入 answer 阶段时保留 streamingThinking，避免正文流式输出时思考面板消失。
              if (hasThinkingContent && (
                hasCommittedThinking
                || isOpencodeLikeAgent(sessionId)
                || (
                  getSessionStreamPhase(sessionId) === 'answer'
                  && getSessionAgentKind(sessionId) === 'claude_code'
                )
              )) {
                clearStreamingTextField(sessionId, 'streamingThinking', set, get);
              }
            }
            clearStreamingTextField(sessionId, 'streamingText', set, get);
          } else if (contentBlock?.type === 'tool_use') {
            const toolId = contentBlock.id as string;
            const toolName = contentBlock.name as string;
            const blockIndex = streamEvent.index as number | undefined;
            logger.debug('Tool use block started', { sessionId, toolId, toolName, blockIndex });
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
            setSessionStreamPhase(sessionId, 'thinking');
            // Reclassify any content that was mis-routed into the answer stream.
            const misrouted = get().streamingText[sessionId] || '';
            if (misrouted) {
              flushPendingStreaming(sessionId, set);
              set((s) => ({
                streamingThinking: {
                  ...s.streamingThinking,
                  [sessionId]: appendStreamingPreview(s.streamingThinking[sessionId] || '', misrouted),
                },
                streamingText: { ...s.streamingText, [sessionId]: '' },
                streamingVersion: {
                  ...s.streamingVersion,
                  [sessionId]: (s.streamingVersion[sessionId] ?? 0) + 1,
                },
              }));
              sessionsWithLiveTextStream.delete(sessionId);
            }
            queueStreamingDelta(sessionId, 'thinking', delta.thinking, set);
          } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            // OpenCode streams reasoning with field=text (text_delta). Keep it in the
            // reasoning panel until this turn enters the answer phase.
            // Other agents emit real answer text via text_delta — don't hijack them.
            const phase = getSessionStreamPhase(sessionId);
            const preferThinking = isOpencodeLikeAgent(sessionId) && phase !== 'answer';
            if (preferThinking) {
              setSessionStreamPhase(sessionId, 'thinking');
              if (get().streamingText[sessionId]) {
                flushPendingStreaming(sessionId, set);
                const misrouted = get().streamingText[sessionId] || '';
                set((s) => ({
                  streamingThinking: {
                    ...s.streamingThinking,
                    [sessionId]: appendStreamingPreview(s.streamingThinking[sessionId] || '', misrouted),
                  },
                  streamingText: { ...s.streamingText, [sessionId]: '' },
                  streamingVersion: {
                    ...s.streamingVersion,
                    [sessionId]: (s.streamingVersion[sessionId] ?? 0) + 1,
                  },
                }));
                sessionsWithLiveTextStream.delete(sessionId);
              }
              queueStreamingDelta(sessionId, 'thinking', delta.text, set);
            } else {
              if (phase === 'thinking' && !isOpencodeLikeAgent(sessionId)) {
                setSessionStreamPhase(sessionId, 'answer');
              }
              queueStreamingDelta(sessionId, 'text', delta.text, set);
            }
          }
        } else if (eventType === 'content_block_stop') {
          const blockType = (streamEvent.content_block as Record<string, unknown> | undefined)?.type as string | undefined;
          if (blockType === 'thinking') {
            logger.debug('Thinking block stopped', { sessionId });
          } else if (blockType === 'text') {
            logger.debug('Text block stopped', { sessionId });
          } else if (blockType === 'tool_use') {
            const toolId = findToolId(streamEvent.index as number | undefined);
            logger.debug('Tool use block stopped', { sessionId, toolId });
          }
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
              daemonFacade.readFile(filePath, projectPath).then((original) => {
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
                ...(event.kind === 'permission' ? { pendingPermissions: enqueuePendingPermission(s.pendingPermissions, sessionId, event.data) } : {}),
                streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                streamedToolUseIds: { ...s.streamedToolUseIds, [sessionId]: newIds },
                ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
              };
            });
          } else {
            flushPendingStreaming(sessionId, set);
          }
        }
      }
      return;
    }

    const forceStopped = forceStoppedNow;
    if (forceStopped && shouldSuppressLiveEventWhileStopped(event.kind)) {
      if (event.kind === 'result') {
        resolveInterruptDrain(sessionId);
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
            queuePaused: { ...s.queuePaused, [sessionId]: true },
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
      logger.debug('Processing assistant event', { sessionId, blockCount: (event.data?.message?.content as any[] | undefined)?.length ?? 0 });
      // Commit any pending simulated stream immediately before processing.
      commitPendingSimulatedStream(sessionId, set);

      flushPendingStreaming(sessionId, set);
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      const incomingToolOnly = blocks.length > 0 && blocks.every((block: { type?: string }) => block?.type === 'tool_use');
      if (incomingToolOnly) {
        commitLiveStreamingNarration(sessionId, set, get);
      }
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

      // If the SDK did not stream incrementally, simulate progressive render.
      const textBlock = filtered.find(
        (b: any): b is { type: 'text'; text: string } =>
          b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0,
      );
      const thinkingBlock = filtered.find(
        (b: any): b is { type: 'thinking'; thinking: string } =>
          b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0,
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
      const thinkingOnly = Boolean(thinkingBlock && !textBlock && !hasToolUse);
      // Superseding events must replace their target in place; routing them
      // through the simulated-stream buffer would append them at the end.
      const supersedesExisting = Array.isArray(event.data.supersedes) && event.data.supersedes.length > 0;
      const narrationInsertAt = isNarrationOnlyAssistantEvent(event)
        ? findNarrationAssistantInsertionIndex(get().events[sessionId] || [])
        : undefined;
      const shouldSimulate = Boolean(
        !hasToolUse
        && !supersedesExisting
        && !isNarrationContinuationAssistantEvent(event)
        && narrationInsertAt == null
        && !currentStreamingText
        && !currentStreamingThinking
        && (textBlock || thinkingBlock),
      );
      if (shouldSimulate) {
        const chunks: Array<{ key: keyof StreamingBuffer; text: string }> = [];
        if (thinkingBlock) chunks.push({ key: 'thinking', text: thinkingBlock.thinking });
        if (textBlock) chunks.push({ key: 'text', text: textBlock.text });
        simulateStreamingContent(sessionId, event, chunks, set);
        return;
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
        if (thinkingOnly && s.streamingText[sessionId]) {
          const fullThinking = thinkingBlock!.thinking;
          const liveText = s.streamingText[sessionId];
          if (
            liveText === fullThinking
            || fullThinking.startsWith(liveText)
            || liveText.startsWith(fullThinking)
          ) {
            updates.streamingText = { ...s.streamingText, [sessionId]: '' };
            sessionsWithLiveTextStream.delete(sessionId);
          }
        }
        if (thinkingOnly) {
          // OpenCode commits a completed reasoning part before publishing its
          // following tool calls. Keeping that part in the live buffer makes
          // the thread append it after those tools, reversing the event order.
          // The committed assistant event now owns this completed reasoning.
          resetSessionStreamPhase(sessionId);
          if (s.streamingThinking[sessionId]) {
            updates.streamingThinking = { ...s.streamingThinking, [sessionId]: '' };
            updates.streamingVersion = {
              ...s.streamingVersion,
              [sessionId]: (s.streamingVersion[sessionId] ?? 0) + 1,
            };
          }
        } else if (textBlock) {
          setSessionStreamPhase(sessionId, 'answer');
          // Answer arrived: clear live reasoning so committed Thread panel + markdown take over.
          if (s.streamingThinking[sessionId]) {
            updates.streamingThinking = { ...s.streamingThinking, [sessionId]: '' };
          }
          if (s.streamingText[sessionId]) {
            updates.streamingText = { ...s.streamingText, [sessionId]: '' };
          }
        } else {
          if (s.streamingThinking[sessionId]) {
            updates.streamingThinking = { ...s.streamingThinking, [sessionId]: '' };
          }
          if (s.streamingText[sessionId]) {
            updates.streamingText = { ...s.streamingText, [sessionId]: '' };
          }
        }
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
      resetSessionStreamPhase(sessionId);
      logger.info('Agent query result received', {
        sessionId,
        isError: event.data?.is_error,
      });
      commitPendingSimulatedStream(sessionId, set);
    }

    set((s) => {
      const prev = s.events[sessionId] || [];
      const supersededAssistantIds = event.kind === 'assistant' && Array.isArray(event.data.supersedes)
        ? new Set(event.data.supersedes)
        : null;
      const hasSuperseded = Boolean(supersededAssistantIds && supersededAssistantIds.size > 0);
      const supersededMatchIndex = hasSuperseded
        ? prev.findIndex((entry) => entry.kind === 'assistant' && supersededAssistantIds!.has(entry.data.uuid))
        : -1;
      const baseEvents = hasSuperseded
        ? prev.filter((entry) => entry.kind !== 'assistant' || !supersededAssistantIds!.has(entry.data.uuid))
        : prev;
      // Replace the previous placeholder instead of stacking duplicates.
      let newEvents: AgentMessage[];
      if (supersededMatchIndex >= 0) {
        // Superseding an earlier assistant event replaces it in place so
        // late-finalizing content keeps its original timeline position.
        newEvents = prev
          .filter((entry, index) => index === supersededMatchIndex
            || !(entry.kind === 'assistant' && supersededAssistantIds!.has(entry.data.uuid)))
          .map((entry, index) => (index === supersededMatchIndex ? event : entry));
      } else if (event.kind === 'stream_status' && event.data.is_reconnecting) {
        newEvents = replaceLastOrAppend(baseEvents, event, isReconnectingStreamStatus);
      } else if (
        event.kind === 'compact' &&
        event.data.compact_metadata?.status === 'completed'
      ) {
        // A completed compaction replaces its own loading placeholder
        // instead of stacking a second compact marker.
        newEvents = replaceLastOrAppend(
          baseEvents,
          event,
          (entry) => entry.kind === 'compact' && entry.data.compact_metadata?.status === 'compacting',
        );
      } else if (
        event.kind === 'assistant'
        && isNarrationContinuationAssistantEvent(event)
        && !hasSuperseded
      ) {
        newEvents = appendPiContinuationAssistantMessage(
          baseEvents,
          event,
          sessionId,
        );
      } else if (
        event.kind === 'assistant'
        && isNarrationOnlyAssistantEvent(event)
        && !hasSuperseded
      ) {
        if (getSessionAgentKind(sessionId) === 'pi') {
          newEvents = appendPiNarrationFinalAfterTools(baseEvents, event, sessionId);
        } else {
          const narrationText = narrationTextFromAssistantEvent(event);
          const replaceAt = narrationText != null
            ? findReplaceableLiveNarrationIndex(baseEvents, narrationText, sessionId)
            : undefined;
          if (replaceAt != null) {
            newEvents = baseEvents.map((entry, index) => (index === replaceAt ? event : entry));
          } else {
            const insertAt = findNarrationAssistantInsertionIndex(baseEvents);
            newEvents = insertAt != null
              ? [...baseEvents.slice(0, insertAt), event, ...baseEvents.slice(insertAt)]
              : [...baseEvents, event];
          }
        }
      } else {
        newEvents = insertPiProcessEventBeforeTrailingNarration(baseEvents, event, sessionId);
      }
      if (event.kind === 'result') {
        newEvents = normalizeTurnProcessEventOrder(newEvents);
      }
      if (isTerminalAgentEvent(event.kind, Boolean(event.kind === 'result' && event.data?.is_error))) {
        newEvents = stripEphemeralLiveStreamNarrationEvents(
          newEvents.filter((entry) => !isReconnectingStreamStatus(entry)),
        );
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
        ...(event.kind === 'permission' ? { pendingPermissions: enqueuePendingPermission(s.pendingPermissions, sessionId, event.data) } : {}),
        ...(event.kind === 'permission_resolved' ? { pendingPermissions: dequeueResolvedPermission(s.pendingPermissions, sessionId, event.data.request_id) } : {}),
        ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
      };
    });
    // Update MCP runtime status from polling results (local to agentStore)
    if (event.kind === 'mcp_status') {
      if (event.data.status) {
        set((s) => ({
          mcpRuntimeStatus: { ...s.mcpRuntimeStatus, [sessionId]: event.data.status || null },
        }));
      }
    }

    const isTerminalEvent = isTerminalAgentEvent(event.kind, Boolean(event.kind === 'result' && event.data?.is_error));
    // Any flow terminal event (real or synthesized continuation boundary)
    // ends the "children done, parent about to summarize" wait.
    if (isTerminalEvent) {
      useSubagentStore.getState().markContinuationSettled(sessionId);
    }
    const isSyntheticBoundary = event.kind === 'result' && Boolean(event.data?.synthetic);
    if (isTerminalEvent && !shouldProcessTerminalEvent(get().isRunning[sessionId] ?? false, event.kind, Boolean(event.kind === 'result' && event.data?.is_error), isSyntheticBoundary)) {
      // 合成 continuation 边界只代表后台汇总流收尾:用户没有活动回合时
      // (isActiveQuery 为假),清掉 daemon state 帧置位的 isRunning 并
      // 派发排队消息;用户回合进行中绝不抢跑。
      if (isSyntheticBoundary && !isActiveQuery()) {
        set((s) => ({ isRunning: { ...s.isRunning, [sessionId]: false } }));
        dispatchNextQueuedQuery(sessionId);
      }
      return;
    }

    if (isTerminalEvent) {
      if (!isActiveQuery()) {
        // 后台回合(如子智能体汇总)的终点:用户没有活动回合,安全收尾
        // 并派发排队消息。既有行为是直接忽略,导致 isRunning 卡真、
        // 本地队列永不派发。
        set((s) => ({ isRunning: { ...s.isRunning, [sessionId]: false } }));
        dispatchNextQueuedQuery(sessionId);
        return;
      }
      clearPendingStreaming(sessionId);
      clearPendingStreamingToolInputs(sessionId);
      const terminalFailed = event.kind === 'error'
        || (event.kind === 'result' && Boolean(event.data?.is_error));
      set((s) => {
        const { [sessionId]: _removed, ...rest } = s.queryStartTime;
        return {
          isRunning: { ...s.isRunning, [sessionId]: false },
          queryStartTime: rest,
          streamingText: { ...s.streamingText, [sessionId]: '' },
          streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
          queuePaused: terminalFailed
            ? { ...s.queuePaused, [sessionId]: true }
            : s.queuePaused,
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
      if (event.kind === 'result' && !event.data?.is_error) {
        void get().refreshLatestTokenUsage(sessionId, 'live_synced');
      }
      if (!terminalFailed) {
        dispatchNextQueuedQuery(sessionId);
      }
    }
  };
}

  return ({
  events: {},
  turns: {},
  eventTimestamps: {},
  isRunning: {},
  backgroundLive: {},
  queryStartTime: {},
  error: {},
  mcpRuntimeStatus: {},
  todos: {},
  tokenUsageBySession: {},
  tokenUsageRefreshRequests: {},
  streamingThinking: {},
  streamingText: {},
  streamingVersion: {},
  streamingThinkingStartEventCount: {},
  forceStopped: {},
  streamingToolInputs: {},
  streamingToolMeta: {},
  streamingToolIndexMap: {},
  streamedToolUseIds: {},
  changedFiles: {},
  fileOriginals: {},
  acknowledgedFiles: {},
  composerDrafts: {},
  pendingComposerRestore: {},
  pendingComposerReferenceInsert: {},
  queuedQueries: {},
  sessionWorkingPaths: loadSessionWorkingPaths(),
  queuePaused: {},
  pendingPermissions: {},

  setSessionWorkingPath: (sessionId, cwd) => {
    const trimmed = cwd.trim();
    if (!isValidWorkingPath(trimmed)) {
      return;
    }

    set((state) => ({
      sessionWorkingPaths: updateSessionWorkingPaths(state.sessionWorkingPaths, sessionId, trimmed),
    }));
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === sessionId ? { ...session, working_path: trimmed } : session
      )),
      archivedSessions: state.archivedSessions.map((session) => (
        session.id === sessionId ? { ...session, working_path: trimmed } : session
      )),
    }));
    void daemonFacade.updateWorkingPath(sessionId, trimmed).catch((error) => {
      logger.warn('Failed to persist session working path', { sessionId }, serializeError(error));
    });
  },

  startQuery: async (sessionId: string, prompt: string, cwd: string, reasoningEffort?: ReasoningEffort, displayContent?: string, inputPayload?: AgentInputPayload, modelForVision?: string, fromQueue = false) => {
    const targetSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
      ?? useSessionStore.getState().archivedSessions.find((session) => session.id === sessionId);
    if (targetSession?.is_read_only) {
      set((state) => ({ error: { ...state.error, [sessionId]: '会话为只读，原生会话无法恢复' } }));
      return;
    }
    get().setSessionWorkingPath(sessionId, cwd);
    const pendingHistoryLoad = pendingSessionMessageLoads.get(sessionId);
    if (pendingHistoryLoad) {
      await pendingHistoryLoad;
    }
    const currentState = get();
    // 会话未收尾即排队:父回合运行中、派发在途之外,后台子智能体仍在运行、
    // 或刚全部结束等待父进程汇总回合的窗口,同样算忙——与 daemon 侧发送
    // 排队语义一致。消息进本地可见队列,流程收尾时按序派发。
    const subagentSession = useSubagentStore.getState().sessions[sessionId];
    const childrenRunning = Boolean(
      subagentSession?.order.some((id) => subagentSession.descriptors[id]?.status === 'running'),
    );
    const continuationPending = Boolean(useSubagentStore.getState().continuationPending[sessionId]);
    const shouldQueue =
      !fromQueue
      && (
        Boolean(currentState.isRunning[sessionId])
        || queuedDispatches.has(sessionId)
        || childrenRunning
        || continuationPending
      );
    if (shouldQueue) {
      const queuedQuery = createQueuedQuery(
        prompt,
        cwd,
        reasoningEffort,
        displayContent,
        inputPayload,
        modelForVision,
      );
      set((state) => ({
        queuedQueries: {
          ...state.queuedQueries,
          [sessionId]: [...(state.queuedQueries[sessionId] ?? []), queuedQuery],
        },
      }));
      return;
    }

    clearPendingStreaming(sessionId);
    clearPendingStreamingToolInputs(sessionId);
    set((state) => ({ pendingPermissions: { ...state.pendingPermissions, [sessionId]: [] } }));
    resetSessionStreamPhase(sessionId);
    set((s) => ({ forceStopped: { ...s.forceStopped, [sessionId]: false } }));

    let queryStartedAt = get().queryStartTime[sessionId] ?? Date.now();
    const originalPayload = inputPayload ?? { text: prompt };
    const attachments = getPayloadAttachments(originalPayload);
    const appConfig = useSettingsStore.getState().config;
    const enrichmentConfig = appConfig?.attachment_enrichment;
    const enrichmentEnabled = isImageRecognitionConfigured(enrichmentConfig);
    const providers = appConfig?.model_providers ?? [];
    // 会话供应商优先：同一模型 ID 可能同时存在于多个供应商且模态配置不同，
    // 全局摊平查找会命中排在前面的那条（如智谱与 OpenCode Go 都有 glm-5.3-flash）。
    const modelMetadata = findSessionModelMetadata(modelForVision, providers, targetSession?.provider_id);
    const supportsVision = !payloadHasAttachments(originalPayload)
      || resolveVisionCapability(modelForVision, modelMetadata, enrichmentEnabled);
    const shouldSendImages = attachments.length > 0 && supportsVision;
    let payloadForModel: AgentInputPayload = shouldSendImages
      ? originalPayload
      : { text: originalPayload.text };
    const droppedImages = attachments.length > 0 && !shouldSendImages && !enrichmentEnabled;
    const userContent = displayContent ?? originalPayload.text;

    logger.info('MODEL_TRACE startQuery dispatching via Daemon Client', {
      sessionId,
      cwd,
      displayModel: modelForVision || 'default',
      reasoningEffort: reasoningEffort || 'high',
      promptLength: prompt.length,
    });
    setSessionStreamPhase(sessionId, 'thinking');
    // Auto-update session title from the first user message (skip slash commands)
    const state = get();
    const hasExistingUserMsg = (state.events[sessionId] || []).some(e => e.kind === 'user');
    const userAttachments = getPayloadImageAttachments(originalPayload).map((image) => ({
      type: 'image' as const,
      name: image.name,
      mediaType: image.mediaType,
      dataUrl: image.dataUrl,
    }));
    if (!hasExistingUserMsg) {
      if (userContent.trim()) {
        const title = buildSessionTitleFromUserContent(userContent);
        if (title !== '未命名对话') {
          useSessionStore.getState().updateSessionTitle(sessionId, title);
        }
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
        ...(userAttachments.length > 0 ? { attachments: userAttachments } : {}),
      },
    };
    queryStartedAt = Date.now();
    set((s) => ({
      events: {
        ...s.events,
        [sessionId]: [...(s.events[sessionId] || []), userMsg],
      },
      eventTimestamps: {
        ...s.eventTimestamps,
        [sessionId]: [...(s.eventTimestamps[sessionId] || []), queryStartedAt],
      },
      isRunning: { ...s.isRunning, [sessionId]: true },
      queryStartTime: { ...s.queryStartTime, [sessionId]: queryStartedAt },
      error: { ...s.error, [sessionId]: null },
      queuePaused: { ...s.queuePaused, [sessionId]: false },
    }));
    // A new prompt supersedes the "waiting for the parent summary" wait.
    useSubagentStore.getState().markContinuationSettled(sessionId);

    try {
      if (attachments.length > 0 && !supportsVision && enrichmentEnabled) {
        try {
          const enrichmentResponse = await daemonFacade.enrichAttachments(attachments);
          const blocks = enrichmentResponse.blocks ?? [];
          const successfulBlocks = filterSuccessfulEnrichmentBlocks(blocks);
          const failureCount = countEnrichmentFailures(blocks);
          const failureSummary = firstEnrichmentFailureSummary(blocks);
          if (successfulBlocks.length > 0) {
            payloadForModel = {
              text: mergeEnrichedContext(originalPayload.text, successfulBlocks),
              historyAttachments: attachments,
            };
          }
          if (failureSummary) {
            logger.warn('Attachment enrichment partial or total failure', {
              sessionId,
              model: modelForVision || 'default',
              failureCount,
              successCount: successfulBlocks.length,
              failureSummary,
            });
          }
        } catch (error) {
          logger.warn('Attachment enrichment failed; falling back to text-only payload', {
            sessionId,
            model: modelForVision || 'default',
          }, serializeError(error));
          payloadForModel = { text: originalPayload.text };
        }
      } else if (droppedImages) {
        logger.info('Skipping image payload for model without vision support', {
          sessionId,
          model: modelForVision || 'default',
        });
        set((s) => ({
          events: {
            ...s.events,
            [sessionId]: [
              ...(s.events[sessionId] || []),
              {
                kind: 'stream_status',
                data: {
                  message: '当前模型不支持图片。请在设置 → 图片识别中配置解析模型，或在模型编辑中勾选「视觉」输入模态。',
                  is_reconnecting: false,
                },
              },
            ],
          },
          eventTimestamps: {
            ...s.eventTimestamps,
            [sessionId]: [...(s.eventTimestamps[sessionId] || []), Date.now()],
          },
        }));
      }

      const handleEvent = createSessionEventHandler(sessionId, get, set, modelForVision);
      registerDaemonSessionHandler(sessionId, handleEvent, (running) => {
        if (!running) return;
        set((s) => {
          if (s.isRunning[sessionId]) return {};
          return {
            isRunning: { ...s.isRunning, [sessionId]: true },
            queryStartTime: {
              ...s.queryStartTime,
              [sessionId]: s.queryStartTime[sessionId] ?? Date.now(),
            },
          };
        });
      });
      await daemonFacade.sendMessageViaDaemon(
        sessionId,
        payloadForModel.text,
        payloadForModel,
      );
    } catch (err) {
      logger.error('Agent query failed to start or stream', { sessionId, cwd, displayModel: modelForVision }, serializeError(err));
      set((s) => {
        const { [sessionId]: _removed, ...rest } = s.queryStartTime;
        return {
          isRunning: { ...s.isRunning, [sessionId]: false },
          queryStartTime: rest,
          error: { ...s.error, [sessionId]: String(err) },
        };
      });
      useSessionStore.getState().markSessionUnread(sessionId);
      throw err;
    }
  },

  attachToActiveTurn: async (sessionId: string, cwd: string, reasoningEffort?: ReasoningEffort) => {
    if (get().isRunning[sessionId] && !get().backgroundLive[sessionId]) {
      return true;
    }

    set((s) => ({
      backgroundLive: { ...s.backgroundLive, [sessionId]: true },
    }));
    await get().loadSessionMessages(sessionId, { force: true });

    const companionTurnActive = await daemonFacade.isSessionTurnActive(sessionId);
    if (!shouldAttachLiveTurn(get().events[sessionId] ?? [], companionTurnActive)) {
      stopBackgroundPoll(sessionId);
      set((s) => {
        const { [sessionId]: _live, ...liveRest } = s.backgroundLive;
        return { backgroundLive: liveRest };
      });
      return false;
    }

    const queryStartedAt = get().queryStartTime[sessionId] ?? Date.now();
    setSessionStreamPhase(sessionId, 'thinking');
    set((s) => ({
      isRunning: { ...s.isRunning, [sessionId]: true },
      backgroundLive: { ...s.backgroundLive, [sessionId]: true },
      queryStartTime: { ...s.queryStartTime, [sessionId]: queryStartedAt },
      error: { ...s.error, [sessionId]: null },
      queuePaused: { ...s.queuePaused, [sessionId]: false },
    }));

    stopBackgroundPoll(sessionId);
    backgroundPolls.set(sessionId, window.setInterval(() => {
      void get().completeBackgroundLiveIfIdle(sessionId);
    }, 1000));

    await daemonFacade.ensureAgentSession(sessionId, cwd, undefined, reasoningEffort);
    return get().isRunning[sessionId] ?? false;
  },

  completeBackgroundLiveIfIdle: async (sessionId: string) => {
    if (!get().backgroundLive[sessionId]) return;
    await get().loadSessionMessages(sessionId, { force: true });
    const companionTurnActive = await daemonFacade.isSessionTurnActive(sessionId);
    if (shouldAttachLiveTurn(get().events[sessionId] ?? [], companionTurnActive)) {
      return;
    }
    stopBackgroundPoll(sessionId);
    set((s) => {
      const { [sessionId]: _removed, ...rest } = s.queryStartTime;
      const { [sessionId]: _live, ...liveRest } = s.backgroundLive;
      return {
        isRunning: { ...s.isRunning, [sessionId]: false },
        backgroundLive: liveRest,
        queryStartTime: rest,
      };
    });
  },

  attachLiveSession: async (sessionId: string) => {
    if (get().isRunning[sessionId]) return true;
    let turnActive = false;
    try {
      turnActive = await daemonFacade.isSessionTurnActive(sessionId);
    } catch (error) {
      logger.warn('Failed to query session turn state for live attach', { sessionId }, serializeError(error));
      return false;
    }
    if (!turnActive) return false;

    // 刷新后内存订阅尽失;daemon 会话 WS 连上即回放 timeline tail 并续流,
    // sequence 由 loadSessionMessages 预置的 lastSequence 去重。
    setSessionStreamPhase(sessionId, 'thinking');
    set((s) => ({
      isRunning: { ...s.isRunning, [sessionId]: true },
      queryStartTime: { ...s.queryStartTime, [sessionId]: s.queryStartTime[sessionId] ?? Date.now() },
      error: { ...s.error, [sessionId]: null },
    }));

    const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
    const handleEvent = createSessionEventHandler(sessionId, get, set, session?.model ?? null);
    registerDaemonSessionHandler(sessionId, handleEvent, (running) => {
      if (!running) return;
      set((s) => {
        if (s.isRunning[sessionId]) return {};
        return {
          isRunning: { ...s.isRunning, [sessionId]: true },
          queryStartTime: {
            ...s.queryStartTime,
            [sessionId]: s.queryStartTime[sessionId] ?? Date.now(),
          },
        };
      });
    });
    return true;
  },

  respondToPermission: async (sessionId: string, requestId: string, response: AgentPermissionResponse) => {
    const request = (get().pendingPermissions[sessionId] ?? []).find((item) => item.request_id === requestId);
    if (!request) return;
    try {
      await daemonFacade.respondToPermissionViaDaemon(sessionId, request.request_id, response);
      set((state) => ({
        pendingPermissions: {
          ...state.pendingPermissions,
          [sessionId]: (state.pendingPermissions[sessionId] ?? []).filter((item) => item.request_id !== requestId),
        },
      }));
    } catch (error) {
      set((state) => ({ error: { ...state.error, [sessionId]: String(error) } }));
    }
  },
  interrupt: async (sessionId: string) => {
    clearPendingStreaming(sessionId);
    clearPendingStreamingToolInputs(sessionId);
    set((state) => ({ pendingPermissions: { ...state.pendingPermissions, [sessionId]: [] } }));
    clearSimulatedStream(sessionId);
    const state = get();
    const isRunning = state.isRunning[sessionId] ?? false;
    const forceStopped = state.forceStopped[sessionId] ?? false;
    const events = state.events[sessionId] || [];
    const lastEvent = events[events.length - 1];
    // 父回合已结束但后台子智能体流未收尾时同样可以停止:sidecar interrupt
    // 会把 running 的子智能体全部置为 failed 并广播 upsert。
    const subagentSession = useSubagentStore.getState().sessions[sessionId];
    const childrenRunning = Boolean(
      subagentSession?.order.some((id) => subagentSession.descriptors[id]?.status === 'running'),
    );
    const continuationPending = Boolean(useSubagentStore.getState().continuationPending[sessionId]);

    if ((!isRunning && !childrenRunning && !continuationPending) || forceStopped || lastEvent?.kind === 'done') {
      logger.info('Ignoring interrupt for inactive agent query', {
        sessionId,
        isRunning,
        childrenRunning,
        continuationPending,
        forceStopped,
        lastEvent: lastEvent?.kind ?? 'none',
      });
      return;
    }

    logger.info('Interrupting agent query', { sessionId, isRunning, childrenRunning });
    beginInterruptDrain(sessionId);
    // 1. Immediately update UI — BEFORE sending command to sidecar
    set((s) => {
      const { [sessionId]: _removed, ...rest } = s.queryStartTime;
      return {
        forceStopped: { ...s.forceStopped, [sessionId]: true },
        isRunning: { ...s.isRunning, [sessionId]: false },
        queryStartTime: rest,
        streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
        streamingText: { ...s.streamingText, [sessionId]: '' },
        queuePaused: { ...s.queuePaused, [sessionId]: true },
      };
    });

    // 2. Then tell sidecar to stop (async, non-blocking for UI)
    try {
      await daemonFacade.interruptViaDaemon(sessionId);
    } catch {
      // Sidecar may already be gone — UI is already stopped.
    }
    // 子智能体取消后父进程可能不会再被唤醒,不清 continuation 等待会让
    // 后续发送一直进队列。
    useSubagentStore.getState().markContinuationSettled(sessionId);
  },

  removeQueuedQuery: (sessionId: string, queryId: string) => {
    set((state) => ({
      queuedQueries: {
        ...state.queuedQueries,
        [sessionId]: (state.queuedQueries[sessionId] ?? []).filter((query) => query.id !== queryId),
      },
    }));
  },

  reorderQueuedQuery: (sessionId: string, queryId: string, targetIndex: number) => {
    set((state) => {
      const current = state.queuedQueries[sessionId] ?? [];
      const sourceIndex = current.findIndex((query) => query.id === queryId);
      if (sourceIndex < 0 || current.length < 2) {
        return {};
      }

      const boundedIndex = Math.max(0, Math.min(targetIndex, current.length - 1));
      if (sourceIndex === boundedIndex) {
        return {};
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(boundedIndex, 0, moved);
      return {
        queuedQueries: { ...state.queuedQueries, [sessionId]: next },
      };
    });
  },

  resumeQueuedQueries: (sessionId: string) => {
    set((state) => ({
      queuePaused: { ...state.queuePaused, [sessionId]: false },
      error: state.error[sessionId]
        ? { ...state.error, [sessionId]: null }
        : state.error,
    }));
    dispatchNextQueuedQuery(sessionId);
  },

  runQueuedQueryNow: async (sessionId: string, queryId: string) => {
    const queue = get().queuedQueries[sessionId] ?? [];
    const query = queue.find((item) => item.id === queryId);
    if (!query) {
      return;
    }

    const targetSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
      ?? useSessionStore.getState().archivedSessions.find((session) => session.id === sessionId);
    const wasRunning = get().isRunning[sessionId] ?? false;
    const prefersSteer = normalizeImmediateRunMode(useSettingsStore.getState().config?.immediate_run_mode) === 'steer';
    const canSteer = prefersSteer
      && wasRunning
      && !isSteerBlockedPrompt(query.prompt)
      && !!targetSession
      && supportsCapability(targetSession.agent_kind, 'supports_steer');

    if (canSteer) {
      const requestId = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      get().removeQueuedQuery(sessionId, queryId);
      inflightSteerRequests.set(requestId, { sessionId, query });
      try {
        await daemonFacade.sendMessageViaDaemon(
          sessionId,
          query.prompt,
          query.inputPayload,
          { delivery: 'steer', requestId },
        );
      } catch (error) {
        inflightSteerRequests.delete(requestId);
        logger.error('Agent steer failed; falling back to interrupt', { sessionId, queryId }, serializeError(error));
        restoreQueuedQueryAtFront(sessionId, query);
        await interruptAndRunQueuedQuery(sessionId, query.id);
      }
      return;
    }

    await interruptAndRunQueuedQuery(sessionId, queryId);
  },

  clearQueuedQueries: (sessionId: string) => {
    set((state) => ({
      queuedQueries: { ...state.queuedQueries, [sessionId]: [] },
      queuePaused: { ...state.queuePaused, [sessionId]: false },
    }));
  },

  clearEvents: (sessionId: string) => {
    clearPendingStreaming(sessionId);
    clearSimulatedStream(sessionId);
    useSubagentStore.getState().clearSession(sessionId);
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
      const newTokenUsage = { ...state.tokenUsageBySession };
      delete newTokenUsage[sessionId];
      const newTokenUsageRefreshRequests = { ...state.tokenUsageRefreshRequests };
      delete newTokenUsageRefreshRequests[sessionId];
      const newStreaming = { ...state.streamingThinking };
      delete newStreaming[sessionId];
      const newStreamingText = { ...state.streamingText };
      delete newStreamingText[sessionId];
      const newStreamingVersion = { ...state.streamingVersion };
      delete newStreamingVersion[sessionId];
      const newForceStopped = { ...state.forceStopped };
      delete newForceStopped[sessionId];
      const newQueuedQueries = { ...state.queuedQueries };
      delete newQueuedQueries[sessionId];
      const newQueuePaused = { ...state.queuePaused };
      delete newQueuePaused[sessionId];
      return {
        events: newEvents,
        eventTimestamps: newTimestamps,
        isRunning: newRunning,
        error: newError,
        mcpRuntimeStatus: newMcpRuntimeStatus,
        todos: newTodos,
        tokenUsageBySession: newTokenUsage,
        tokenUsageRefreshRequests: newTokenUsageRefreshRequests,
        streamingThinking: newStreaming,
        streamingText: newStreamingText,
        streamingVersion: newStreamingVersion,
        forceStopped: newForceStopped,
        queuedQueries: newQueuedQueries,
        queuePaused: newQueuePaused,
        pendingPermissions: { ...state.pendingPermissions, [sessionId]: [] },
      };
    });
  },

  setSessionTokenUsage: (sessionId: string, usage: ThreadTokenUsage | null) => {
    set((state) => ({
      tokenUsageBySession: {
        ...state.tokenUsageBySession,
        [sessionId]: usage,
      },
    }));
  },

  refreshLatestTokenUsage: async (sessionId: string, freshness: 'live_synced' | 'restored') => {
    const agentKind: AgentKind = getSessionAgentKind(sessionId) ?? 'claude_code';
    const requestId = Date.now() + Math.random();

    set((state) => {
      const existing = state.tokenUsageBySession[sessionId] ?? null;
      return {
        tokenUsageRefreshRequests: {
          ...state.tokenUsageRefreshRequests,
          [sessionId]: requestId,
        },
        tokenUsageBySession: existing
          ? {
              ...state.tokenUsageBySession,
              [sessionId]: {
                ...existing,
                contextUsageFreshness: 'syncing',
              },
            }
          : state.tokenUsageBySession,
      };
    });

    try {
      const rawUsage = await daemonFacade.loadLatestTokenUsage(sessionId, agentKind, freshness);
      const normalized = normalizeThreadTokenUsage(rawUsage);
      set((state) => {
        if (state.tokenUsageRefreshRequests[sessionId] !== requestId) {
          return {};
        }
        return {
          tokenUsageRefreshRequests: removeSessionEntry(state.tokenUsageRefreshRequests, sessionId),
          tokenUsageBySession: {
            ...state.tokenUsageBySession,
            [sessionId]: normalized,
          },
        };
      });
    } catch (error) {
      logger.warn('Failed to refresh latest token usage from history file', {
        sessionId,
        agentKind,
        freshness,
      }, serializeError(error));
      set((state) => {
        if (state.tokenUsageRefreshRequests[sessionId] !== requestId) {
          return {};
        }
        return {
          tokenUsageRefreshRequests: removeSessionEntry(state.tokenUsageRefreshRequests, sessionId),
        };
      });
    }
  },

  loadSessionMessages: async (sessionId: string, options?: { force?: boolean }) => {
    const pending = pendingSessionMessageLoads.get(sessionId);
    if (pending) {
      return pending;
    }

    // Hydrate the subagent tracks in parallel with the parent timeline.
    const subagentsFetch: Promise<{ subagents: unknown[]; timelines: Record<string, unknown[]> } | null> =
      typeof daemonFacade.loadSessionSubagents === 'function'
        ? daemonFacade.loadSessionSubagents(sessionId)
            .then((payload) => {
              useSubagentStore.getState().replaceSession(sessionId, payload);
              return payload;
            })
            .catch((error) => {
              logger.warn('Failed to load session subagents', { sessionId }, serializeError(error));
              return null;
            })
        : Promise.resolve(null);

    const loadPromise = (async () => {
      const agentKind = getSessionAgentKind(sessionId);
      const loadEpoch = getSessionHistoryEpoch(sessionId);

      try {
        const timelinePage = await daemonFacade.getTimeline(sessionId, {
          direction: 'tail',
          limit: 5000,
        });
        const historyMessages = timelinePage.events ?? [];
        const seqEnd = (timelinePage as { seqEnd?: number }).seqEnd;
        if (typeof seqEnd === 'number' && seqEnd >= 0) {
          setLastEventSequence(sessionId, Math.max(seqEnd, getLastEventSequence(sessionId)));
        }
        if (timelinePage.hasOlder) {
          logger.warn('Session timeline exceeds the defensive load limit; oldest events omitted', {
            sessionId,
            limit: 5000,
          });
        }

        if (getSessionHistoryEpoch(sessionId) !== loadEpoch) {
          logger.info('Discarding stale session history load after rewind', {
            sessionId,
            loadEpoch,
          });
          return;
        }

        if (!historyMessages || historyMessages.length === 0) {
          logger.info('No agent history found for session', {
            sessionId,
            agentKind: agentKind ?? 'claude_code',
          });
          set((state) => ({
            events: state.events[sessionId]
              ? state.events
              : { ...state.events, [sessionId]: [] },
            eventTimestamps: state.eventTimestamps[sessionId]
              ? state.eventTimestamps
              : { ...state.eventTimestamps, [sessionId]: [] },
          }));
          return;
        }

        const loadedTimeline: Array<{ event: AgentMessage; ts: number }> = [];
        // 存量快照里同一条事件可能被写入过多次（历史双写持久化 bug），按
        // event_id 去重，避免刷新后同一消息渲染成两个气泡。
        const seenEventIds = new Set<string>();

        for (const raw of historyMessages) {
          const rawMsg = raw as Record<string, unknown>;
          const eventId = typeof rawMsg.event_id === 'string' ? rawMsg.event_id : null;
          if (eventId) {
            if (seenEventIds.has(eventId)) {
              continue;
            }
            seenEventIds.add(eventId);
          }
          const sequence = typeof rawMsg.sequence === 'number' ? rawMsg.sequence : null;
          if (sequence !== null) {
            setLastEventSequence(sessionId, Math.max(sequence, getLastEventSequence(sessionId)));
          }
          let ts = typeof rawMsg.timestamp === 'string'
            ? new Date(rawMsg.timestamp).getTime() || 0
            : typeof rawMsg.timestamp === 'number'
              ? rawMsg.timestamp
              : 0;
          if (ts === 0 && loadedTimeline.length > 0) {
            ts = loadedTimeline[loadedTimeline.length - 1]?.ts ?? 0;
          }

          const event = isCodeMuxPersistedTimelineEvent(rawMsg)
            ? parseAgentEvent(JSON.stringify(rawMsg))
            : mapPersistedClaudeMessage(rawMsg, agentKind ?? 'claude_code');
          if (event) {
            loadedTimeline.push({ event: event as AgentMessage, ts });
          }
        }

        const collapsedTimeline = collapsePersistedCompactTimeline(loadedTimeline);
        const normalizedTimeline = normalizeTurnProcessTimeline(collapsedTimeline);
        const events = normalizedTimeline.map((entry) => entry.event);
        const timestamps = normalizedTimeline.map((entry) => entry.ts);

        if (getSessionHistoryEpoch(sessionId) !== loadEpoch) {
          logger.info('Discarding stale session history load after rewind', {
            sessionId,
            loadEpoch,
          });
          return;
        }
        const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)
          ?? useSessionStore.getState().archivedSessions.find((entry) => entry.id === sessionId);
        const projectPath = session?.project_id
          ? useProjectStore.getState().projects.find((entry) => entry.id === session.project_id)?.path?.trim() ?? null
          : null;
        const rememberedCwd = extractSessionWorkingPathFromEvents(events);
        const existingWorkingPath = get().sessionWorkingPaths[sessionId] ?? session?.working_path ?? null;

        set((state) => {
          const currentEvents = state.events[sessionId];
          const isSessionRunning = Boolean(state.isRunning[sessionId]);
          const isBackgroundLive = Boolean(state.backgroundLive[sessionId]);
          const keepLiveEvents = Boolean(
            currentEvents?.length
            && shouldKeepLiveEventsOnHistoryLoad(isSessionRunning, isBackgroundLive)
          );
          const preferLocalEvents = Boolean(
            currentEvents?.length
            && shouldPreferLocalEventsOnHistoryLoad(
              currentEvents,
              events,
              isSessionRunning,
              isBackgroundLive,
            )
          );
          const keepCurrentEvents = !options?.force && (keepLiveEvents || preferLocalEvents);
          const nextEvents = keepCurrentEvents ? currentEvents! : events;
          const nextTimestamps = keepCurrentEvents
            ? state.eventTimestamps[sessionId] ?? timestamps
            : timestamps;

          return {
            events: { ...state.events, [sessionId]: nextEvents },
            eventTimestamps: { ...state.eventTimestamps, [sessionId]: nextTimestamps },
            todos: { ...state.todos, [sessionId]: extractTodosFromEvents(nextEvents) },
          };
        });

        if (
          rememberedCwd
          && !existingWorkingPath
          && (!projectPath || rememberedCwd !== projectPath)
        ) {
          get().setSessionWorkingPath(sessionId, rememberedCwd);
        }

        // The CLI backfill of subagent tracks runs during the parent timeline
        // hydration, so an empty first fetch may have raced it — re-fetch once.
        const firstSubagents = await subagentsFetch;
        if ((firstSubagents == null || firstSubagents.subagents.length === 0)
          && typeof daemonFacade.loadSessionSubagents === 'function') {
          try {
            const payload = await daemonFacade.loadSessionSubagents(sessionId);
            useSubagentStore.getState().replaceSession(sessionId, payload);
          } catch (error) {
            logger.warn('Failed to reload session subagents after history load', { sessionId }, serializeError(error));
          }
        }

        await get().refreshLatestTokenUsage(sessionId, 'restored');
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
    })();

    pendingSessionMessageLoads.set(sessionId, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (pendingSessionMessageLoads.get(sessionId) === loadPromise) {
        pendingSessionMessageLoads.delete(sessionId);
      }
    }
  },

  resyncSessionFromNative: async (sessionId: string) => {
    if (get().isRunning[sessionId]) {
      throw new Error('会话正在运行，请先停止后再同步');
    }

    const pending = pendingSessionMessageLoads.get(sessionId);
    if (pending) {
      await pending;
    }

    const result = await daemonFacade.resyncSessionFromNative(sessionId);
    get().clearEvents(sessionId);
    await get().loadSessionMessages(sessionId);
    logger.info('Resynced session history from CLI provider file', {
      sessionId,
      eventCount: result.eventCount,
    });
    return result.eventCount;
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

  saveComposerDraft: (sessionId: string, text: string) => {
    set((s) => ({
      composerDrafts: { ...s.composerDrafts, [sessionId]: text },
    }));
  },

  consumeComposerDraft: (sessionId: string) => {
    const draft = get().composerDrafts[sessionId] ?? '';
    if (draft) {
      set((s) => {
        const { [sessionId]: _, ...rest } = s.composerDrafts;
        return { composerDrafts: rest };
      });
    }
    return draft;
  },

  getComposerDraft: (sessionId: string) => {
    return get().composerDrafts[sessionId] ?? '';
  },

  rewindToMessage: async (sessionId: string, userEventIndex: number, mode: RewindMode = 'conversation') => {
    const state = get();
    const targetSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
      ?? useSessionStore.getState().archivedSessions.find((session) => session.id === sessionId);
    if (targetSession?.is_read_only) {
      return null;
    }
    if (state.isRunning[sessionId]) {
      return null;
    }

    const events = state.events[sessionId] ?? [];
    if (userEventIndex < 0 || userEventIndex >= events.length) {
      return null;
    }
    const userEvent = events[userEventIndex];
    if (!isRewindableUserEvent(userEvent)) {
      return null;
    }

    // Latest conversation rewind can omit a locator (JSONL falls back to the
    // latest user line). Historical rows and Claude file/both rewind send
    // turn ordinal + text fingerprint so the backend can resolve the Claude
    // JSONL uuid without a UI locator.
    const agentKind: AgentKind = getSessionAgentKind(sessionId) ?? 'claude_code';
    if (!supportsRewindMode(agentKind, mode)) {
      return null;
    }
    const latestRewindableIndex = getRewindableUserIndex(events);
    const hasStrongLocator = hasStrongRewindLocator(userEvent.data.locator);
    const payload = buildInputPayloadFromUserEvent(userEvent);
    const turnOrdinal = events
      .slice(0, userEventIndex + 1)
      .filter(isRewindableUserEvent)
      .length;
    const fingerprintTarget: AgentUserMessageLocator = {
      role: 'user',
      textFingerprint: userEvent.data.content,
      turnOrdinal,
    };
    const needsExplicitTarget = mode !== 'conversation'
      || hasStrongLocator
      || userEventIndex !== latestRewindableIndex;
    const target = !needsExplicitTarget
      ? undefined
      : hasStrongLocator
        ? {
            ...userEvent.data.locator,
            ...fingerprintTarget,
          }
        : fingerprintTarget;

    if (mode !== 'files') {
      bumpSessionHistoryEpoch(sessionId);
    }

    let filesChanged: number | undefined;
    const invokeRewind = async (
      rewindTarget: AgentUserMessageLocator | undefined,
    ) => {
      const result = await daemonFacade.rewindSession(sessionId, agentKind, rewindTarget, mode) as {
        filesChanged?: number;
      };
      if (result && typeof result.filesChanged === 'number') {
        filesChanged = result.filesChanged;
      }
    };

    try {
      await invokeRewind(target);
    } catch (error) {
      // Live/timeline rows may carry a CodeMUX event_id that is not the Claude
      // JSONL uuid. Retry conversation rewind by turn ordinal + text fingerprint.
      const canFallBack = mode === 'conversation' && isMissingRewindTargetError(error);
      if (!canFallBack) {
        throw error;
      }
      if (target == null) {
        await invokeRewind(fingerprintTarget);
      } else if (
        target.providerMessageId
        || typeof target.lineIndex === 'number'
        || typeof target.sourceEventIndex === 'number'
      ) {
        await invokeRewind(fingerprintTarget);
      } else if (userEventIndex === latestRewindableIndex) {
        await invokeRewind(undefined);
      } else {
        throw error;
      }
    }

    const rewindResult: RewindMessageResult = mode === 'conversation'
      ? payload
      : { ...payload, filesChanged };

    if (mode === 'files') {
      // File-only rewind keeps the conversation intact; nothing to truncate.
      return rewindResult;
    }

    clearPendingStreaming(sessionId);
    clearPendingStreamingToolInputs(sessionId);
    set((state) => ({ pendingPermissions: { ...state.pendingPermissions, [sessionId]: [] } }));
    clearSimulatedStream(sessionId);

    set((s) => ({
      events: { ...s.events, [sessionId]: events.slice(0, userEventIndex) },
      eventTimestamps: { ...s.eventTimestamps, [sessionId]: (s.eventTimestamps[sessionId] ?? []).slice(0, userEventIndex) },
      isRunning: { ...s.isRunning, [sessionId]: false },
      queryStartTime: removeSessionEntry(s.queryStartTime, sessionId),
      error: { ...s.error, [sessionId]: null },
      mcpRuntimeStatus: removeSessionEntry(s.mcpRuntimeStatus, sessionId),
      todos: removeSessionEntry(s.todos, sessionId),
      tokenUsageBySession: removeSessionEntry(s.tokenUsageBySession, sessionId),
      tokenUsageRefreshRequests: removeSessionEntry(s.tokenUsageRefreshRequests, sessionId),
      streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
      streamingText: { ...s.streamingText, [sessionId]: '' },
      streamingVersion: removeSessionEntry(s.streamingVersion, sessionId),
      forceStopped: { ...s.forceStopped, [sessionId]: false },
      streamingToolInputs: removeSessionEntry(s.streamingToolInputs, sessionId),
      streamingToolMeta: removeSessionEntry(s.streamingToolMeta, sessionId),
      streamingToolIndexMap: removeSessionEntry(s.streamingToolIndexMap, sessionId),
      streamedToolUseIds: removeSessionEntry(s.streamedToolUseIds, sessionId),
      changedFiles: removeSessionEntry(s.changedFiles, sessionId),
      fileOriginals: removeSessionEntry(s.fileOriginals, sessionId),
      acknowledgedFiles: removeSessionEntry(s.acknowledgedFiles, sessionId),
      composerDrafts: removeSessionEntry(s.composerDrafts, sessionId),
    }));

    try {
      localStorage.removeItem(`acknowledged-files-${sessionId}`);
    } catch {}

    return rewindResult;
  },

  requestComposerRestore: (sessionId: string, text: string) => {
    set((state) => ({ pendingComposerRestore: { ...state.pendingComposerRestore, [sessionId]: text } }));
  },

  clearComposerRestore: (sessionId: string) => {
    set((state) => ({ pendingComposerRestore: removeSessionEntry(state.pendingComposerRestore, sessionId) }));
  },

  requestComposerReferenceInsert: (sessionId: string, reference: string, isDirectory = false) => {
    set((state) => ({
      pendingComposerReferenceInsert: {
        ...state.pendingComposerReferenceInsert,
        [sessionId]: { reference, isDirectory },
      },
    }));
  },

  clearComposerReferenceInsert: (sessionId: string) => {
    set((state) => ({
      pendingComposerReferenceInsert: removeSessionEntry(state.pendingComposerReferenceInsert, sessionId),
    }));
  },

  rewindLastTurn: async (sessionId: string) => {
    const latestIndex = getRewindableUserIndex(get().events[sessionId] ?? []);
    if (latestIndex < 0) {
      return null;
    }
    return get().rewindToMessage(sessionId, latestIndex);
  },
});
});

// Keep the lifecycle projection in the store so renderers do not independently
// infer terminal state from the last assistant message. The listener only reacts
// to inputs used by the reducer; its own `turns` update does not recurse.
useAgentStore.subscribe((state, previousState) => {
  const sessionIds = new Set([
    ...Object.keys(state.events),
    ...Object.keys(previousState.events),
    ...Object.keys(state.isRunning),
    ...Object.keys(previousState.isRunning),
    ...Object.keys(state.forceStopped),
    ...Object.keys(previousState.forceStopped),
    ...Object.keys(state.eventTimestamps),
    ...Object.keys(previousState.eventTimestamps),
  ]);
  const changedTurns: Record<string, ConversationTurn<AgentMessage>[]> = {};

  for (const sessionId of sessionIds) {
    if (
      state.events[sessionId] === previousState.events[sessionId]
      && state.isRunning[sessionId] === previousState.isRunning[sessionId]
      && state.forceStopped[sessionId] === previousState.forceStopped[sessionId]
      && state.eventTimestamps[sessionId] === previousState.eventTimestamps[sessionId]
    ) {
      continue;
    }

    changedTurns[sessionId] = buildConversationTurns(state.events[sessionId] ?? [], {
      isRunning: state.isRunning[sessionId] ?? false,
      forceStopped: state.forceStopped[sessionId] ?? false,
      sessionId,
      timestamps: state.eventTimestamps[sessionId],
    });
  }

  if (Object.keys(changedTurns).length > 0) {
    useAgentStore.setState({ turns: { ...state.turns, ...changedTurns } });
  }
});
