import type { SubagentObservation } from './claudeSubagentObservations.js';
import {
  toCodeMuxEvent,
  type NextSectionKind,
  type OpenCodeEventContext,
  type StreamingPartState,
} from './opencodeEvents.js';
import type { TurnSourceEvent } from './turnEventNormalizer.js';

/**
 * OpenCode subagent adapter, observation half (spec seam 1, OpenCode flavor).
 *
 * OpenCode runs each subagent in its own child session on the same event bus
 * as the parent. There is no task_started/sidechain protocol: the parent
 * session announces the task via a `subtask` part and/or the Task tool part
 * whose `state.metadata.sessionId` names the child session. This module turns
 * those signals and child-session traffic into provider-neutral observations;
 * stateful alias/binding bookkeeping lives in opencodeSubagentSource.ts.
 */

/** Parent task-tool names that can declare a subagent (case-insensitive). */
export function isOpenCodeTaskToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'task' || normalized === 'agent';
}

export type OpenCodeSubagentDeclaration = Extract<SubagentObservation, { kind: 'declared' }>;

/** Declaration observation from a parent-side `subtask` part. */
export function observeOpenCodeSubtaskPart(part: Record<string, unknown>): OpenCodeSubagentDeclaration | undefined {
  const id = readString(part.callID) ?? readString(part.id);
  if (!id) return undefined;
  const agent = readString(part.agent) ?? readString(part.subagent_type);
  const description = readString(part.description);
  const prompt = readString(part.prompt);
  if (!agent && !description && !prompt) return undefined;
  return {
    kind: 'declared',
    taskId: id,
    toolUseIds: [id],
    ...(agent ? { title: agent } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    isWorkflow: false,
    provider: 'opencode',
  };
}

export type OpenCodeTaskToolBinding = {
  toolUseId: string;
  childSessionId: string;
  /** Assistant message the tool part belongs to; matches subtask declarations. */
  messageId?: string;
  /** Fallback declaration from the tool input when no prior declaration exists. */
  declaration?: OpenCodeSubagentDeclaration;
};

/**
 * Binding signal from a parent-side Task tool part: the part's
 * `state.metadata.sessionId` names the child session running the task.
 */
export function observeOpenCodeTaskToolPart(part: Record<string, unknown>): OpenCodeTaskToolBinding | undefined {
  const toolUseId = readString(part.callID) ?? readString(part.id);
  const state = asRecord(part.state);
  const metadata = asRecord(state?.metadata);
  const childSessionId = readString(metadata?.sessionId)
    ?? readString(metadata?.sessionID)
    ?? readString(metadata?.session_id);
  if (!toolUseId || !childSessionId) return undefined;

  const input = asRecord(state?.input) ?? {};
  const title = readString(input.subagent_type) ?? readString(input.agent) ?? readString(part.agent);
  const description = readString(input.description);
  const prompt = readString(input.prompt);
  const declaration: SubagentObservation | undefined = title || description || prompt
    ? {
        kind: 'declared',
        taskId: toolUseId,
        toolUseIds: [toolUseId],
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        isWorkflow: false,
        provider: 'opencode',
      }
    : undefined;
  return {
    toolUseId,
    childSessionId,
    ...(readString(part.messageID) ? { messageId: readString(part.messageID) } : {}),
    ...(declaration ? { declaration } : {}),
  };
}

/**
 * Per-child projection state. Each child session streams like a parent turn,
 * so it needs its own part-state machine and message bookkeeping, isolated
 * from the parent timeline's state.
 */
export type OpenCodeChildProjectionState = {
  streamingParts: Map<string, StreamingPartState>;
  nextSection: { kind: NextSectionKind };
  idleStreamKind: { kind: 'thinking' | 'text' };
  /** Child user-message ids; their text parts must not render as child speech. */
  userMessageIds: Set<string>;
  assistantMessageIds: Set<string>;
  compactionSummaryMessageIds: Set<string>;
  assistantMessageIdsBeforeCompaction: Set<string>;
  compactionSummaryInFlight: boolean;
};

export function createOpenCodeChildProjectionState(): OpenCodeChildProjectionState {
  return {
    streamingParts: new Map(),
    nextSection: { kind: 'idle' },
    idleStreamKind: { kind: 'thinking' },
    userMessageIds: new Set(),
    assistantMessageIds: new Set(),
    compactionSummaryMessageIds: new Set(),
    assistantMessageIdsBeforeCompaction: new Set(),
    compactionSummaryInFlight: false,
  };
}

export type OpenCodeChildProjectionIO = {
  eventIdFactory: () => string;
};

/**
 * Project one child-session OpenCode event into parent-normalizer-shaped
 * source events. The projection reuses toCodeMuxEvent (streaming, provisional
 * envelopes, tool lifecycle) and then folds the CodeMUX events back into
 * TurnSourceEvents; timeline-irrelevant kinds (turn boundaries, system and
 * diagnostic events, permission prompts) are dropped here.
 */
export function projectOpenCodeChildEvent(
  event: unknown,
  childState: OpenCodeChildProjectionState,
  io: OpenCodeChildProjectionIO,
): TurnSourceEvent[] {
  trackChildMessageRoles(event, childState);
  const context: OpenCodeEventContext = {
    agentId: '',
    sessionId: '',
    sequence: 0,
    eventIdFactory: io.eventIdFactory,
    streamingParts: childState.streamingParts,
    nextSection: childState.nextSection,
    idleStreamKind: childState.idleStreamKind,
    userMessageIds: childState.userMessageIds,
    assistantMessageIds: childState.assistantMessageIds,
    compactionSummaryMessageIds: childState.compactionSummaryMessageIds,
    compactionSummaryInFlight: childState.compactionSummaryInFlight,
    assistantMessageIdsBeforeCompaction: childState.compactionSummaryInFlight
      ? childState.assistantMessageIdsBeforeCompaction
      : undefined,
  };
  const projected = toCodeMuxEvent(event, context);
  const sourceEvents: TurnSourceEvent[] = [];
  for (const projectedEvent of projected) {
    const source = toOpenCodeTurnSourceEvent(projectedEvent);
    if (source) sourceEvents.push(source);
  }
  return sourceEvents;
}

function trackChildMessageRoles(event: unknown, childState: OpenCodeChildProjectionState): void {
  const record = asRecord(event);
  if (readString(record?.type) !== 'message.updated') return;
  const info = asRecord(asRecord(record?.properties)?.info);
  const messageId = readString(info?.id);
  const role = readString(info?.role);
  if (!messageId) return;
  if (role === 'user') childState.userMessageIds.add(messageId);
  if (role === 'assistant') childState.assistantMessageIds.add(messageId);
}

/** Map one projected CodeMUX event onto the parent normalizer's source shape. */
export function toOpenCodeTurnSourceEvent(event: Record<string, unknown>): TurnSourceEvent | undefined {
  switch (event.type) {
    case 'content_started':
      return { kind: 'content_started', index: readNumber(event.index) ?? 0, contentKind: event.content_kind === 'reasoning' ? 'reasoning' : 'text' };
    case 'text_delta':
      return { kind: 'text_delta', index: readNumber(event.index) ?? 0, text: readString(event.text) ?? '' };
    case 'reasoning_delta':
      return { kind: 'reasoning_delta', index: readNumber(event.index) ?? 0, text: readString(event.text) ?? '' };
    case 'content_finished':
      return { kind: 'content_finished', index: readNumber(event.index) ?? 0 };
    case 'assistant_message': {
      const providerMessageId = readString(event.provider_message_id);
      const supersedes = Array.isArray(event.supersedes_provider_message_ids)
        ? event.supersedes_provider_message_ids.filter((id): id is string => typeof id === 'string')
        : [];
      return {
        kind: 'assistant_message',
        content: Array.isArray(event.content) ? (event.content as Array<Record<string, unknown>>) : [],
        // OpenCode reuses the bare messageID for every part's final envelope
        // (thinking → tools → text share one messageID). The normalizer's
        // per-message snapshot dedupe would drop all but the first part, so
        // the id is qualified by the envelope content; the projection's own
        // committed-text check already prevents true duplicate deliveries.
        ...(providerMessageId
          ? { providerMessageId: `${providerMessageId}#${stableContentKey(event.content)}` }
          : {}),
        ...(supersedes.length > 0 ? { supersedesProviderMessageIds: supersedes } : {}),
      };
    }
    case 'tool_started':
      return {
        kind: 'tool_started',
        toolUseId: readString(event.tool_use_id) ?? '',
        name: readString(event.name) ?? 'unknown',
        input: asRecord(event.input) ?? {},
      };
    case 'tool_finished':
      return {
        kind: 'tool_finished',
        toolUseId: readString(event.tool_use_id) ?? '',
        content: readString(event.content) ?? '',
        isError: event.is_error === true,
      };
    case 'error':
      return { kind: 'error', subtype: readString(event.subtype) ?? 'subagent_error', message: readString(event.error) ?? 'OpenCode subagent error' };
    default:
      // turn_finished / system_event / diagnostic / permission_requested /
      // user_input_requested / tool_input_delta stay out of the child timeline.
      return undefined;
  }
}

/** Map a child session terminal event onto the CodeMUX lifecycle status. */
export function mapOpenCodeChildTerminalStatus(type: string): 'completed' | 'failed' | 'canceled' | undefined {
  switch (type) {
    case 'session.idle':
      return 'completed';
    case 'session.error':
      return 'failed';
    case 'session.interrupted':
    case 'session.aborted':
      return 'canceled';
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stableContentKey(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .map((block) => {
      const record = asRecord(block);
      if (!record) return String(block);
      const type = readString(record.type) ?? 'block';
      const text = readString(record.text) ?? readString(record.thinking) ?? '';
      return `${type}:${text}`;
    })
    .join('|');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
