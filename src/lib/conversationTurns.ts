import { isClaudeTaskNotificationUserEvent, isCodexCompactSummaryText, isInterruptMarker } from '@/stores/agentEventParsing';
import type { AgentMessage } from '@/stores/agentStore';
import type {
  ConversationTurn,
  ConversationTurnDiagnostic,
  ConversationTurnStatus,
  ConversationTurnTermination,
  ConversationTurnUsage,
} from '@/types/conversationTurn';

export interface ConversationTurnOptions {
  isRunning?: boolean;
  forceStopped?: boolean;
  retainRawEvents?: boolean;
  sessionId?: string;
  latestUsage?: ConversationTurnUsage;
}

type MutableTurn = {
  id: string;
  messages: AgentMessage[];
  eventIndices: number[];
  pendingToolIds: Set<string>;
  diagnostics: ConversationTurnDiagnostic[];
  assistantEventIndices: number[];
  rawEvents?: unknown[];
  usage?: ConversationTurnUsage;
  durationMs?: number;
  numTurns?: number;
  completionReason?: string;
  interruptionReason?: string;
  failureReason?: string;
  hasInterruptionSignal: boolean;
  hasRealUser: boolean;
};

export function buildConversationTurns(
  events: AgentMessage[],
  options: ConversationTurnOptions = {},
): ConversationTurn<AgentMessage>[] {
  const turns: ConversationTurn<AgentMessage>[] = [];
  let current: MutableTurn | null = null;
  let turnOrdinal = 0;
  let prelude: Array<{ event: AgentMessage; index: number }> = [];

  const finishCurrent = (isLast: boolean) => {
    if (!current) {
      return;
    }

    turns.push(finalizeTurn(current, {
      isLast,
      isRunning: options.isRunning ?? false,
      forceStopped: options.forceStopped ?? false,
      retainRawEvents: options.retainRawEvents ?? false,
      latestUsage: options.latestUsage,
    }));
    current = null;
  };

  events.forEach((event, index) => {
    if (isRealUserEvent(event)) {
      finishCurrent(false);
      turnOrdinal += 1;
      current = createTurn(event, index, turnOrdinal, options.sessionId);
      for (const item of prelude) {
        appendEvent(current, item.event, item.index, options.retainRawEvents ?? false);
      }
      prelude = [];
      appendEvent(current, event, index, options.retainRawEvents ?? false);
      return;
    }

    if (!current) {
      // System metadata before the first prompt is attached to the first Turn.
      if (isTurnMetadata(event)) {
        prelude.push({ event, index });
        return;
      }
      // Some legacy projections omit the user row. Keep their agent events in
      // a compatibility Turn so the transcript and footer remain renderable.
      turnOrdinal += 1;
      current = createTurn(event, index, turnOrdinal, options.sessionId);
      for (const item of prelude) {
        appendEvent(current, item.event, item.index, options.retainRawEvents ?? false);
      }
      prelude = [];
      appendEvent(current, event, index, options.retainRawEvents ?? false);
      return;
    }

    if (event.kind === 'compact' && !current.hasRealUser) {
      finishCurrent(false);
      prelude.push({ event, index });
      return;
    }

    appendEvent(current, event, index, options.retainRawEvents ?? false);
  });

  finishCurrent(true);
  return turns;
}

export function buildConversationTurnIndex(
  turns: ConversationTurn<AgentMessage>[],
): Map<number, ConversationTurn<AgentMessage>> {
  const index = new Map<number, ConversationTurn<AgentMessage>>();
  for (const turn of turns) {
    for (const eventIndex of turn.eventIndices) {
      index.set(eventIndex, turn);
    }
  }
  return index;
}

export function isRealConversationUserEvent(
  event: Extract<AgentMessage, { kind: 'user' }>,
): boolean {
  const data = event.data as Record<string, unknown>;
  const content = typeof data.content === 'string' ? data.content.trim() : '';

  if (
    isInterruptMarker(content)
    || isClaudeTaskNotificationUserEvent(data)
    || data.isCompactSummary === true
    || data.isVisibleInTranscriptOnly === true
    || isCodexCompactSummaryText(content)
    || content === '/compact'
    || /^<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>$/i.test(content)
  ) {
    return false;
  }

  const message = data.message;
  if (isRecord(message) && Array.isArray(message.content) && message.content.length > 0) {
    return !message.content.every((block) => isRecord(block) && block.type === 'tool_result');
  }

  return true;
}

function createTurn(
  event: AgentMessage,
  index: number,
  ordinal: number,
  sessionId?: string,
): MutableTurn {
  const uuid = getEventUuid(event);
  const turn: MutableTurn = {
    id: uuid ?? `${sessionId ? `${sessionId}-` : ''}turn-${ordinal}-${index}`,
    messages: [],
    eventIndices: [],
    pendingToolIds: new Set<string>(),
    diagnostics: [],
    assistantEventIndices: [],
    rawEvents: undefined,
    hasInterruptionSignal: false,
    hasRealUser: event.kind === 'user' && isRealConversationUserEvent(event),
  };

  return turn;
}

function appendEvent(
  turn: MutableTurn,
  event: AgentMessage,
  index: number,
  retainRawEvents: boolean,
): void {
  turn.messages.push(event);
  turn.eventIndices.push(index);
  if (retainRawEvents) {
    turn.rawEvents ??= [];
    turn.rawEvents.push(event);
  }

  if (event.kind === 'assistant') {
    turn.assistantEventIndices.push(index);
    const blocks = Array.isArray(event.data.message?.content) ? event.data.message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0) {
        turn.pendingToolIds.add(block.id);
      }
    }

    if (event.data.message?.stop_reason === 'end_turn') {
      turn.completionReason = 'end_turn';
    }

    if (event.data.message?.usage) {
      turn.usage = normalizeUsage(event.data.message.usage);
    }
    return;
  }

  const rawToolResults = event.kind === 'user'
    ? getRawToolResults(event)
    : undefined;
  const toolResults = event.kind === 'tool_result'
    ? event.data.message?.content ?? []
    : rawToolResults;

  if (toolResults) {
    for (const result of toolResults) {
      if (typeof result.tool_use_id !== 'string') {
        addDiagnostic(turn, 'malformed_tool_result', 'Tool result is missing tool_use_id.', index);
        continue;
      }
      if (!turn.pendingToolIds.delete(result.tool_use_id)) {
        addDiagnostic(turn, 'unmatched_tool_result', `No pending tool use for ${result.tool_use_id}.`, index);
      }
      if (result.is_error === true) {
        turn.failureReason = stringifyContent(result.content) || 'Tool execution failed.';
      }
    }
    return;
  }

  if (event.kind === 'result') {
    if (event.data.is_error) {
      turn.failureReason = typeof event.data.result === 'string' && event.data.result.trim()
        ? event.data.result.trim()
        : event.data.subtype || 'Agent execution failed.';
    } else {
      turn.completionReason = event.data.subtype || 'result';
    }
    turn.usage = normalizeUsage(event.data.last_token_usage ?? event.data.usage);
    turn.durationMs = isSyntheticResult(event.data as unknown as Record<string, unknown>)
      ? undefined
      : finiteNumber(event.data.duration_ms);
    turn.numTurns = finiteNumber(event.data.num_turns);
    return;
  }

  if (event.kind === 'error') {
    turn.failureReason = event.data.error || 'Agent runtime error.';
    return;
  }

  if (event.kind === 'ask_user_question_timeout') {
    turn.failureReason = event.data.message || 'User input request timed out.';
    return;
  }

  if (event.kind === 'done') {
    turn.hasInterruptionSignal = true;
    turn.interruptionReason = 'Agent stream ended without a confirmed result.';
    return;
  }

  if (event.kind === 'user' && typeof event.data.content === 'string' && isInterruptMarker(event.data.content)) {
    turn.hasInterruptionSignal = true;
    turn.interruptionReason = 'Request interrupted by user.';
    return;
  }

  if (event.kind === 'raw') {
    const rawType = event.data.type;
    if (rawType === 'error' || event.data.is_error === true) {
      turn.failureReason = readReason(event.data) || 'Agent runtime error.';
    } else {
      addDiagnostic(turn, 'unknown_event', `Preserved unknown event${typeof rawType === 'string' ? `: ${rawType}` : ''}.`, index);
    }
  }
}

function getRawToolResults(
  event: Extract<AgentMessage, { kind: 'user' }>,
): Array<{ type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }> | undefined {
  const data = event.data as Record<string, unknown>;
  const message = data.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }

  const blocks = message.content.filter((block): block is Record<string, unknown> => (
    isRecord(block) && block.type === 'tool_result'
  ));
  if (blocks.length === 0) {
    return undefined;
  }

  return blocks.map((block) => ({
    type: 'tool_result',
    tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
    content: block.content,
    ...(block.is_error === true ? { is_error: true } : {}),
  }));
}

function finalizeTurn(
  turn: MutableTurn,
  options: {
    isLast: boolean;
    isRunning: boolean;
    forceStopped: boolean;
    retainRawEvents: boolean;
    latestUsage?: ConversationTurnUsage;
  },
): ConversationTurn<AgentMessage> {
  const pendingToolIds = [...turn.pendingToolIds];
  let status: ConversationTurnStatus;
  let termination: ConversationTurnTermination | undefined;
  const hasConfirmedCompletion = turn.completionReason !== undefined && pendingToolIds.length === 0;
  const usage = options.isLast && options.latestUsage ? options.latestUsage : turn.usage;

  if (turn.failureReason) {
    status = 'failed';
    termination = { kind: 'failed', reason: turn.failureReason };
  } else if (hasConfirmedCompletion) {
    status = 'completed';
    termination = { kind: 'completed', reason: turn.completionReason };
  } else if (
    turn.hasInterruptionSignal
    || pendingToolIds.length > 0
    || options.forceStopped
    || !options.isLast
    || !options.isRunning
  ) {
    status = 'interrupted';
    termination = { kind: 'interrupted', reason: turn.interruptionReason };
  } else {
    status = 'running';
  }

  return {
    id: turn.id,
    messages: turn.messages,
    eventIndices: turn.eventIndices,
    hasRealUser: turn.hasRealUser,
    status,
    pendingToolIds,
    ...(status === 'completed' && usage ? { usage } : {}),
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    ...(turn.numTurns !== undefined ? { numTurns: turn.numTurns } : {}),
    ...(termination ? { termination } : {}),
    diagnostics: turn.diagnostics,
    ...(options.retainRawEvents && turn.rawEvents ? { rawEvents: turn.rawEvents } : {}),
    ...(turn.assistantEventIndices.length > 0
      ? { footerAnchorEventIndex: turn.assistantEventIndices[turn.assistantEventIndices.length - 1] }
      : {}),
  };
}

function normalizeUsage(value: unknown): ConversationTurnUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage: ConversationTurnUsage = {
    ...(finiteNumber(value.input_tokens) !== undefined ? { inputTokens: finiteNumber(value.input_tokens) } : {}),
    ...(finiteNumber(value.output_tokens) !== undefined ? { outputTokens: finiteNumber(value.output_tokens) } : {}),
    ...(finiteNumber(value.cache_read_input_tokens ?? value.cached_input_tokens) !== undefined
      ? { cacheReadTokens: finiteNumber(value.cache_read_input_tokens ?? value.cached_input_tokens) }
      : {}),
    ...(finiteNumber(value.cache_creation_input_tokens) !== undefined
      ? { cacheCreationTokens: finiteNumber(value.cache_creation_input_tokens) }
      : {}),
  };

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function addDiagnostic(turn: MutableTurn, code: string, message: string, eventIndex: number): void {
  turn.diagnostics.push({ code, message, eventIndex });
}

function isRealUserEvent(event: AgentMessage): event is Extract<AgentMessage, { kind: 'user' }> {
  return event.kind === 'user' && isRealConversationUserEvent(event);
}

function isTurnMetadata(event: AgentMessage): boolean {
  return event.kind === 'system' || event.kind === 'raw' || event.kind === 'ready';
}

function getEventUuid(event: AgentMessage): string | undefined {
  if ('data' in event && isRecord(event.data)) {
    const uuid = (event.data as Record<string, unknown>).uuid;
    return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined;
  }
  return undefined;
}

function readReason(data: Record<string, unknown>): string | undefined {
  for (const key of ['error', 'message', 'reason']) {
    if (typeof data[key] === 'string' && data[key].trim()) {
      return data[key].trim();
    }
  }
  return undefined;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content == null) {
    return '';
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isSyntheticResult(data: Record<string, unknown>): boolean {
  return data.synthetic === true || (typeof data.uuid === 'string' && data.uuid.startsWith('synthetic-'));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
