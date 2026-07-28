import { createHash } from 'node:crypto';
import type { RuntimeEventContext } from './types.js';
import { toCodeMuxStreamEvent } from './codeMuxProtocol.js';
import {
  type AssistantContentBlock,
  type OpenCodeTokenUsage,
} from './runtimeEvents.js';

export type CodeMuxEvent = Record<string, unknown>;

export type StreamingPartState = {
  kind: 'text' | 'thinking';
  index: number;
  started: boolean;
  buffered?: true;
  deltaText?: string[];
  streamedByNext?: true;
};

export type NextSectionKind = 'idle' | 'reasoning' | 'text';

export interface OpenCodeEventContext extends RuntimeEventContext {
  durationMs?: number;
  usage?: OpenCodeTokenUsage;
  seenEventIds?: ReadonlySet<string>;
  seenPayloadKeys?: ReadonlySet<string>;
  terminalSessionIds?: ReadonlySet<string>;
  terminalToolIds?: ReadonlySet<string>;
  turnId?: number;
  assistantMessageIds?: ReadonlySet<string>;
  userMessageIds?: ReadonlySet<string>;
  eventIdFactory: () => string;
  streamingParts?: Map<string, StreamingPartState>;
  nextSection?: { kind: NextSectionKind };
  /**
   * When session.next.* is absent, field=text is ambiguous (reasoning + answer both use it).
   * Prefer thinking until a reasoning part is finalized, then text.
   */
  idleStreamKind?: { kind: 'thinking' | 'text' };
}

export function getOpenCodeEventIdentity(event: unknown, turnId = 0): string | undefined {
  const record = asRecord(event);
  const explicitId = [
    record?.id,
    record?.eventId,
    record?.event_id,
  ].find((value): value is string => typeof value === 'string' && value.length > 0);
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  const sessionId = getOpenCodeEventSessionId(event);
  if (explicitId) {
    return `${type}:${sessionId ?? 'session'}:id:${explicitId}`;
  }
  if (sessionId && isTerminalSessionEvent(type)) {
    return `${type}:${sessionId}:turn:${turnId}`;
  }
  return undefined;
}

export function getOpenCodePayloadKey(event: unknown): string {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  const sessionId = getOpenCodeEventSessionId(event) ?? '';
  const identifiers = [
    readString(part?.id),
    readString(part?.callID),
    readString(part?.messageID),
    readString(properties?.messageID),
    readString(properties?.toolID),
    readString(properties?.toolId),
  ].filter((value): value is string => value !== undefined);
  const canonical = Buffer.from(stableStringify(event), 'utf8');
  const fingerprint = createHash('sha256').update(canonical).digest('hex');
  return `${type}:session:${sessionId}:ids:${identifiers.join('|')}:payload_sha256:${fingerprint}`;
}

export function getOpenCodeEventSessionId(event: unknown): string | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const info = asRecord(properties?.info);
  const part = asRecord(properties?.part);
  return readString(properties?.sessionID) ?? readString(info?.sessionID) ?? readString(part?.sessionID);
}

export function getOpenCodeToolId(event: unknown): string | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  return readString(part?.callID) ?? readString(part?.id);
}

export function getOpenCodeToolStatus(event: unknown): string | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  const state = asRecord(part?.state);
  return readString(state?.status);
}

export type OpenCodeUsageUpdate = {
  usage: OpenCodeTokenUsage;
  mode: 'snapshot' | 'step';
};

export function extractOpenCodeUsageUpdate(event: unknown): OpenCodeUsageUpdate | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  const info = asRecord(properties?.info);
  const partTokens = asRecord(part?.tokens);
  const infoTokens = asRecord(info?.tokens);
  const tokens = partTokens ?? infoTokens;
  if (!tokens) return undefined;
  const cache = asRecord(tokens.cache);
  const input = readNumber(tokens.input);
  const output = readNumber(tokens.output);
  const total = readNumber(tokens.total);
  const reasoning = readNumber(tokens.reasoning);
  const cacheRead = readNumber(cache?.read);
  const cacheWrite = readNumber(cache?.write);
  if (input === undefined && output === undefined && reasoning === undefined && cacheRead === undefined && cacheWrite === undefined && total === undefined) return undefined;
  // SDK message.updated info.tokens are cumulative snapshots; step-finish part.tokens are per-step deltas.
  return {
    mode: partTokens ? 'step' : 'snapshot',
    usage: {
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
      ...(total !== undefined ? { total_tokens: total } : {}),
      ...(reasoning !== undefined ? { reasoning_output_tokens: reasoning } : {}),
      ...(cacheRead !== undefined ? { cached_input_tokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cache_write_input_tokens: cacheWrite } : {}),
    },
  };
}

export function extractOpenCodeUsage(event: unknown): OpenCodeTokenUsage | undefined {
  return extractOpenCodeUsageUpdate(event)?.usage;
}

export function mergeOpenCodeUsage(previous: OpenCodeTokenUsage, next: OpenCodeTokenUsage, mode: 'snapshot' | 'step' = 'snapshot'): OpenCodeTokenUsage {
  const mergeValue = (previousValue: number, nextValue: number): number => mode === 'step' ? previousValue + nextValue : Math.max(previousValue, nextValue);
  const merged: OpenCodeTokenUsage = {
    input_tokens: mergeValue(previous.input_tokens, next.input_tokens),
    output_tokens: mergeValue(previous.output_tokens, next.output_tokens),
  };
  const optionalKeys: Array<keyof Pick<OpenCodeTokenUsage, 'cached_input_tokens' | 'cache_write_input_tokens' | 'cache_creation_input_tokens' | 'reasoning_output_tokens' | 'total_tokens'>> = [
    'cached_input_tokens',
    'cache_write_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  for (const key of optionalKeys) {
    const value = next[key];
    const previousValue = previous[key];
    if (value !== undefined || previousValue !== undefined) {
      merged[key] = mergeValue(previousValue ?? 0, value ?? 0);
    }
  }
  return merged;
}


export function toCodeMuxEvent(event: unknown, context: OpenCodeEventContext): CodeMuxEvent[] {
  const identity = getOpenCodeEventIdentity(event, context.turnId);
  const payloadKey = identity ? undefined : getOpenCodePayloadKey(event);
  if ((identity && context.seenEventIds?.has(identity)) || (payloadKey && context.seenPayloadKeys?.has(payloadKey))) return [];

  const record = asRecord(event);
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  const properties = asRecord(record?.properties) ?? {};
  const eventSessionId = getOpenCodeEventSessionId(event);
  const sessionId = eventSessionId;
  if (isTerminalSessionEvent(type) && sessionId && context.terminalSessionIds?.has(sessionId)) return [];

  const allProps = Object.keys(properties).length > 0 ? (() => { try { return JSON.stringify(properties).slice(0, 1500) } catch { return String(properties) } })() : '(no properties)';
  process.stderr.write(`[opencode-debug] toCodeMuxEvent type=${type} sessionId=${sessionId ?? 'null'} properties=${allProps}\n`);

  const events: CodeMuxEvent[] = [];
  if (isOpenCodeSessionScopedEvent(type) && !eventSessionId) {
    events.push(buildEnvelope({ type: 'diagnostic', subtype: 'missing_session_id', event_type: type }, context, undefined));
    return events.map((output, index) => ({ ...output, sequence: context.sequence + index }));
  }
  switch (type) {
    case 'message.part.updated': {
      const part = asRecord(properties.part);
      if (!part) break;
      const messageId = readString(part.messageID);
      if (messageId && context.userMessageIds?.has(messageId)) break;
      const partId = readString(part.id);
      const partType = readString(part.type);
      const partState = partId ? context.streamingParts?.get(partId) : undefined;
      if (partType === 'text' || partType === 'reasoning') {
        if (partState?.buffered) {
          if (partType === 'reasoning') partState.kind = 'thinking';
          else if (partType === 'text') partState.kind = 'text';
          const text = partState.deltaText?.join('') ?? readString(properties.delta) ?? readString(part.text) ?? '';
          partState.deltaText = [];
          if (partState.kind === 'thinking') {
            events.push(buildStreamEvent(sessionId, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
            if (text) {
              events.push(buildStreamEvent(sessionId, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } }));
            }
            events.push(buildStreamEvent(sessionId, { type: 'content_block_stop', index: 0 }));
          }
          if (text) {
            events.push(buildAssistantEnvelope(context, sessionId, [{
              type: partState.kind,
              ...(partState.kind === 'thinking' ? { thinking: text } : { text }),
            }]));
          }
          if (context.idleStreamKind && partType === 'text') context.idleStreamKind.kind = 'text';
        } else if (partState) {
          // Authoritative part type wins over provisional stream kind.
          if (partType === 'reasoning') partState.kind = 'thinking';
          else if (partType === 'text') partState.kind = 'text';
          // Only emit content_block_stop when this part was actually streamed
          // (had a content_block_start). part.updated can arrive twice for a
          // part (start marker + end marker); the start-marker arrival must not
          // emit a stop without a matching start.
          if (partState.started) {
            events.push(buildStreamEvent(sessionId, { type: 'content_block_stop', index: partState.index }));
          }
          const text = readString(properties.delta) ?? readString(part.text) ?? '';
          if (text) {
            events.push(buildAssistantEnvelope(context, sessionId, [{
              type: partState.kind,
              ...(partState.kind === 'thinking' ? { thinking: text } : { text }),
            }]));
          }
          // Only advance idleStreamKind to 'text' when a text part finalizes.
          // A reasoning part finalizing does NOT mean subsequent parts are text —
          // OpenCode may emit multiple reasoning parts within one turn.
          if (context.idleStreamKind && partType === 'text') {
            context.idleStreamKind.kind = 'text';
          }
          if (context.nextSection && partType === 'reasoning') {
            context.nextSection.kind = 'idle';
          }
        } else {
          // part.updated arrived before any part.delta for this partID
          // (OpenCode typically emits part.updated with text="" as a start
          // marker, then streams part.delta). Pre-create the partState with
          // the authoritative kind from partType so subsequent part.delta
          // events stream into the correct block (thinking vs text) instead
          // of falling back to the unreliable idleStreamKind heuristic.
          if (partId && context.streamingParts) {
            const index = context.streamingParts.size;
            const kind = partType === 'reasoning' ? 'thinking' : 'text';
            context.streamingParts.set(partId, { kind, index, started: false });
          }
          const text = readString(properties.delta) ?? readString(part.text) ?? '';
          if (text) {
            events.push(buildAssistantEnvelope(context, sessionId, [{
              type: partType === 'reasoning' ? 'thinking' : 'text',
              ...(partType === 'reasoning' ? { thinking: text } : { text }),
            }]));
          }
          // Only advance idleStreamKind to 'text' when a text part is seen.
          if (context.idleStreamKind && partType === 'text') {
            context.idleStreamKind.kind = 'text';
          }
        }
      } else if (partType === 'tool') {
        const state = asRecord(part.state);
        const callId = readString(part.callID) ?? readString(part.id) ?? 'unknown-tool';
        if (context.terminalToolIds?.has(callId)) break;
        const toolName = readString(part.tool) ?? 'unknown';
        const isQuestionTool = toolName === 'question' || toolName === 'request_user_input' || toolName === 'AskUserQuestion' || toolName === 'askUserQuestion';
        const status = readString(state?.status);
        if (status === 'pending' || status === 'running') {
          if (isQuestionTool) break;
          events.push(buildToolStartedEvent(context, callId, toolName, asRecord(state?.input) ?? {}));
        } else if (status === 'completed' || status === 'error') {
          const rawOutput = status === 'completed' ? state?.output : state?.error;
          const output = serializeToolValue(rawOutput ?? (status === 'error' ? 'OpenCode tool failed' : ''));
          events.push(buildToolFinishedEvent(context, callId, output, status === 'error'));
        }
      } else if (partType === 'subtask') {
        const prompt = readString(part.prompt) ?? '';
        const description = readString(part.description) ?? '';
        const agent = readString(part.agent) ?? '';
        const callId = readString(part.id) ?? `subtask-${context.turnId}-${context.sequence}`;
        if (prompt || description) {
          events.push(buildToolStartedEvent(context, callId, 'Task', { prompt, description, agent }));
        }
      } else if (partType === 'compaction') {
        const auto = part.auto === true;
        const overflow = part.overflow === true;
        events.push(buildEnvelope({
          type: 'system_event',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          compact_metadata: {
            trigger: auto ? 'auto' : 'manual',
            pre_tokens: 0,
            overflow,
          },
        }, context, sessionId));
      }
      break;
    }
    case 'message.part.delta': {
      const partId = readString(properties.partID);
      const field = readString(properties.field);
      const delta = readString(properties.delta);
      if (!partId || !field || !delta || !context.streamingParts) break;

      const resolveStreamKind = (): 'thinking' | 'text' => {
        if (field === 'reasoning') return 'thinking';
        const sectionKind = context.nextSection?.kind;
        if (sectionKind === 'reasoning') return 'thinking';
        if (sectionKind === 'text') return 'text';
        // field=text without session.next.*: OpenCode uses the same field for
        // reasoning and answer. Prefer thinking until a reasoning part completes.
        return context.idleStreamKind?.kind === 'text' ? 'text' : 'thinking';
      };

      let partState = context.streamingParts.get(partId);
      if (partState?.streamedByNext) break;
      // When session.next.reasoning is active, field=reasoning is redundant.
      if (field === 'reasoning' && context.nextSection?.kind === 'reasoning') break;

      const streamKind = partState?.kind ?? resolveStreamKind();
      if (!partState) {
        const index = context.streamingParts.size;
        partState = { kind: streamKind, index, started: false };
        context.streamingParts.set(partId, partState);
      } else if (partState.buffered) {
        partState.deltaText!.push(delta);
        break;
      }

      if (!partState.started) {
        partState.started = true;
        events.push(buildStreamEvent(sessionId, {
          type: 'content_block_start',
          index: partState.index,
          content_block: partState.kind === 'thinking'
            ? { type: 'thinking', thinking: '' }
            : { type: 'text', text: '' },
        }));
      }
      events.push(buildStreamEvent(sessionId, {
        type: 'content_block_delta',
        index: partState.index,
        delta: partState.kind === 'thinking'
          ? { type: 'thinking_delta', thinking: delta }
          : { type: 'text_delta', text: delta },
      }));
      break;
    }
    case 'message.updated': {
      const info = asRecord(properties.info);
      const error = asRecord(info?.error);
      if (error) events.push(...buildFailureEvents(context, error, sessionId));
      break;
    }
    case 'session.status': {
      const status = asRecord(properties.status);
      const statusType = readString(status?.type) ?? 'unknown';
      if (statusType === 'retry') {
        const retryDelayMs = status!.next ? Math.max(0, Number(status!.next) - Date.now()) : undefined;
        events.push(buildEnvelope({
          type: 'system_event',
          subtype: 'api_retry',
          attempt: Number(status!.attempt) || 0,
          max_retries: Number(status!.max_retries) || 5,
          ...(retryDelayMs !== undefined ? { retry_delay_ms: retryDelayMs } : {}),
          error_status: Number(status!.error_status) || 429,
          error: String(status!.message ?? 'Rate limit exceeded'),
        }, context, sessionId));
      } else {
        events.push(buildEnvelope({ type: 'system_event', subtype: statusType, status: statusType }, context, sessionId));
      }
      break;
    }
    case 'session.idle':
      events.push(buildTurnFinishedEvent(context, 'completed', sessionId));
      break;
    case 'session.error': {
      const error = properties.error ?? properties;
      const outcome = isInterruptedError(error) ? 'interrupted' : 'failed';
      const errorText = errorMessage(error);
      process.stderr.write(`[opencode-task] toCodeMuxEvent session.error sessionId=${sessionId ?? 'null'} outcome=${outcome} error=${errorText} isInterrupted=${isInterruptedError(error)} isTimeout=${isTimeoutError(error)}\n`);
      events.push(buildTurnErrorEvent(context, isTimeoutError(error) ? 'timeout' : outcome, errorText, sessionId));
      events.push(buildTurnFinishedEvent(context, outcome, sessionId, errorText));
      break;
    }
    case 'session.next.reasoning.started': {
      const reasoningID = readString(properties.reasoningID);
      if (reasoningID && context.streamingParts) {
        const index = context.streamingParts.size;
        context.streamingParts.set(reasoningID, { kind: 'thinking', index, started: false, streamedByNext: true });
      }
      if (context.nextSection) context.nextSection.kind = 'reasoning';
      break;
    }
    case 'session.next.reasoning.delta': {
      const deltaReasoningID = readString(properties.reasoningID);
      const deltaText = readString(properties.delta);
      if (deltaReasoningID && deltaText && context.streamingParts) {
        let partState = context.streamingParts.get(deltaReasoningID);
        if (!partState) {
          const index = context.streamingParts.size;
          partState = { kind: 'thinking', index, started: false, streamedByNext: true };
          context.streamingParts.set(deltaReasoningID, partState);
        } else if (partState.buffered) {
          partState.index = context.streamingParts.size;
          partState.buffered = undefined;
          partState.deltaText = [];
          partState.kind = 'thinking';
          partState.streamedByNext = true;
        } else if (partState.kind === 'text') {
          // Was optimistically streamed as text; reclassify as thinking for subsequent deltas.
          partState.kind = 'thinking';
          partState.streamedByNext = true;
        }
        if (!partState.started) {
          partState.started = true;
          events.push(buildStreamEvent(sessionId, {
            type: 'content_block_start',
            index: partState.index,
            content_block: { type: 'thinking', thinking: '' },
          }));
        }
        events.push(buildStreamEvent(sessionId, {
          type: 'content_block_delta',
          index: partState.index,
          delta: { type: 'thinking_delta', thinking: deltaText },
        }));
      }
      break;
    }
    case 'session.next.reasoning.ended':
      break;
    case 'session.next.text.started': {
      if (context.nextSection) context.nextSection.kind = 'text';
      break;
    }
    case 'session.next.text.ended':
      if (context.nextSection) context.nextSection.kind = 'idle';
      break;
    case 'permission.updated':
      events.push(buildEnvelope({
        type: 'permission_requested',
        request_id: readString(properties.id) ?? `permission-${context.sequence}`,
        permission_id: readString(properties.id),
        permission_type: readString(properties.type) ?? 'unknown',
        description: readString(properties.title) ?? readString(properties.type) ?? 'Permission request',
        ...(asRecord(properties.metadata) ? { metadata: asRecord(properties.metadata) } : {}),
        event_id: context.eventIdFactory(),
      }, context, sessionId));
      break;
    case 'question.asked': {
      const questions = readArray(properties.questions);
      if (questions && questions.length > 0) {
        events.push(buildEnvelope({
          type: 'user_input_requested',
          tool_use_id: readString(properties.id) ?? `question-${context.sequence}`,
          questions: questions.map((q: unknown) => {
            const qr = asRecord(q);
            const options = Array.isArray(qr?.options) ? (qr.options as Array<Record<string, unknown>>).map((opt) => ({
              label: String(opt.label ?? ''),
              ...(opt.description ? { description: String(opt.description) } : {}),
            })) : [];
            return { question: readString(qr?.question) ?? '', header: readString(qr?.header), options };
          }),
          event_id: context.eventIdFactory(),
        }, context, sessionId));
      }
      break;
    }
    case 'server.connected':
      events.push(buildEnvelope({ type: 'system_event', subtype: 'connected', status: 'connected' }, context, sessionId));
      break;
    case 'server.retry': {
      const retryError = properties.error;
      const errorStr = errorMessage(retryError);
      process.stderr.write(`[opencode-debug] toCodeMuxEvent server.retry error=${errorStr} attempt=${properties.attempt} maxRetries=${properties.maxRetries} retryDelayMs=${properties.retryDelayMs}\n`);
      events.push(buildEnvelope({ type: 'system_event', subtype: 'retrying', status: 'retrying', ...(retryError !== undefined ? { error: errorStr } : {}) }, context, sessionId));
      break;
    }
    case 'server.disconnected':
    case 'server.error':
    case 'disconnect':
    case 'connection.error': {
      const error = record?.error ?? properties.error ?? record;
      const errorText = errorMessage(error);
      events.push(buildTurnErrorEvent(context, 'disconnected', errorText, sessionId));
      events.push(buildTurnFinishedEvent(context, 'failed', sessionId, errorText));
      break;
    }
    case 'session.interrupted':
    case 'session.aborted':
      process.stderr.write(`[opencode-task] toCodeMuxEvent ${type} sessionId=${sessionId ?? 'null'}\n`);
      events.push(buildTurnFinishedEvent(context, 'interrupted', sessionId, 'OpenCode session interrupted by user'));
      break;
    default:
      events.push(buildEnvelope({ type: 'diagnostic', subtype: 'unknown_event', event_type: type }, context, sessionId));
      break;
  }

  return events.map((output, index) => ({ ...output, sequence: context.sequence + index }));
}

function buildToolStartedEvent(
  context: OpenCodeEventContext,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): CodeMuxEvent {
  return {
    type: 'tool_started',
    session_id: context.sessionId,
    tool_use_id: toolUseId,
    name,
    input,
    event_id: context.eventIdFactory(),
  };
}

function buildToolFinishedEvent(
  context: OpenCodeEventContext,
  toolUseId: string,
  content: string,
  isError: boolean,
): CodeMuxEvent {
  return {
    type: 'tool_finished',
    session_id: context.sessionId,
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    event_id: context.eventIdFactory(),
  };
}

function buildTurnFinishedEvent(
  context: OpenCodeEventContext,
  outcome: 'completed' | 'failed' | 'interrupted',
  sessionId?: string,
  reason?: string,
): CodeMuxEvent {
  const usage = context.usage ?? emptyUsage();
  return {
    type: 'turn_finished',
    session_id: context.sessionId,
    outcome,
    ...(reason ? { reason } : {}),
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: usage.cached_input_tokens ?? 0,
      reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
    },
    duration_ms: context.durationMs ?? 0,
    event_id: context.eventIdFactory(),
    ...routingMetadata(context, sessionId),
  };
}

function buildFailureEvents(context: OpenCodeEventContext, error: unknown, sessionId?: string): CodeMuxEvent[] {
  const outcome = isInterruptedError(error) ? 'interrupted' : 'failed';
  const message = errorMessage(error);
  return [
    buildTurnErrorEvent(context, isTimeoutError(error) ? 'timeout' : outcome, message, sessionId),
    buildTurnFinishedEvent(context, outcome, sessionId, message),
  ];
}

function buildTurnErrorEvent(
  context: OpenCodeEventContext,
  subtype: string,
  error: string,
  sessionId?: string,
): CodeMuxEvent {
  return {
    type: 'error',
    session_id: context.sessionId,
    subtype,
    error,
    event_id: context.eventIdFactory(),
    ...routingMetadata(context, sessionId),
  };
}

function buildAssistantEnvelope(context: OpenCodeEventContext, sessionId: string | undefined, content: Array<Record<string, unknown>>): CodeMuxEvent {
  return {
    type: 'assistant_message',
    session_id: context.sessionId,
    content: content as AssistantContentBlock[],
    event_id: context.eventIdFactory(),
    ...routingMetadata(context, sessionId),
  };
}

function buildStreamEvent(sessionId: string | undefined, event: unknown): CodeMuxEvent {
  return toCodeMuxStreamEvent(sessionId, event) ?? {
    type: 'diagnostic',
    subtype: 'unsupported_stream_event',
    ...(sessionId ? { session_id: sessionId } : {}),
    event_id: crypto.randomUUID(),
  };
}

function buildEnvelope(event: CodeMuxEvent, context: OpenCodeEventContext, sessionId: string | undefined): CodeMuxEvent {
  const eventId = context.eventIdFactory();
  return { ...event, ...routingMetadata(context, sessionId), event_id: eventId, uuid: eventId };
}

function routingMetadata(context: OpenCodeEventContext, sessionId: string | undefined): CodeMuxEvent {
  const openCodeSessionId = sessionId;
  return {
    agent_id: context.agentId,
    session_id: context.sessionId,
    ...(openCodeSessionId ? { agent_session_id: openCodeSessionId, opencode_session_id: openCodeSessionId } : {}),
  };
}

export function isOpenCodeSessionScopedEvent(type: string): boolean {
  return type.startsWith('session.') || type.startsWith('message.') || type.startsWith('tool.') || type.startsWith('permission.');
}

function isTerminalSessionEvent(type: string): boolean {
  return type === 'session.idle' || type === 'session.error' || type === 'session.interrupted' || type === 'session.aborted' || type === 'server.disconnected' || type === 'server.error' || type === 'disconnect' || type === 'connection.error';
}

function emptyUsage(): OpenCodeTokenUsage {
  return { input_tokens: 0, output_tokens: 0 };
}

function serializeToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function isTimeoutError(error: unknown): boolean {
  const text = `${readString(asRecord(error)?.name) ?? ''} ${errorMessage(error)}`.toLowerCase();
  return text.includes('timeout') || text.includes('timed out');
}

function isInterruptedError(error: unknown): boolean {
  const text = `${readString(asRecord(error)?.name) ?? ''} ${errorMessage(error)}`.toLowerCase();
  return text.includes('abort') || text.includes('interrupt') || text.includes('cancel');
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return readString(data?.message) ?? readString(record?.message) ?? readString(record?.name) ?? 'OpenCode event error';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
  const record = asRecord(value);
  if (record) return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(',')}}`;
  return JSON.stringify(value) ?? String(value);
}
