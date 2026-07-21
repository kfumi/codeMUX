import { createHash } from 'node:crypto';
import type { RuntimeEventContext } from './types.js';
import {
  buildAssistantEvent,
  buildOpenCodeResultEvent,
  buildToolResultEvent,
  type AssistantContentBlock,
  type OpenCodeResultStatus,
  type OpenCodeTokenUsage,
} from './runtimeEvents.js';

export type CodeMuxEvent = Record<string, unknown>;

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
  const reasoning = readNumber(tokens.reasoning);
  const cacheRead = readNumber(cache?.read);
  const cacheWrite = readNumber(cache?.write);
  if (input === undefined && output === undefined && reasoning === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  // SDK message.updated info.tokens are cumulative snapshots; step-finish part.tokens are per-step deltas.
  return {
    mode: partTokens ? 'step' : 'snapshot',
    usage: {
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
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
  const optionalKeys: Array<keyof Pick<OpenCodeTokenUsage, 'cached_input_tokens' | 'cache_write_input_tokens' | 'cache_creation_input_tokens' | 'reasoning_output_tokens'>> = [
    'cached_input_tokens',
    'cache_write_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_output_tokens',
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
      const partType = readString(part.type);
      if (partType === 'text' || partType === 'reasoning') {
        const text = readString(properties.delta) ?? readString(part.text);
        if (text) {
          events.push(buildAssistantEnvelope(context, sessionId, [{
            type: partType === 'reasoning' ? 'thinking' : 'text',
            ...(partType === 'reasoning' ? { thinking: text } : { text }),
          }]));
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
          events.push({
            ...buildAssistantEnvelope(context, sessionId, [{ type: 'tool_use', id: callId, name: toolName, input: asRecord(state?.input) ?? {} }]),
            event_kind: 'tool_call',
          });
        } else if (status === 'completed' || status === 'error') {
          const rawOutput = status === 'completed' ? state?.output : state?.error;
          const output = serializeToolValue(rawOutput ?? (status === 'error' ? 'OpenCode tool failed' : ''));
          events.push({
            ...buildToolResultEvent({ sessionId: context.sessionId, toolUseId: callId, content: output, isError: status === 'error', eventIdFactory: context.eventIdFactory }),
            ...routingMetadata(context, sessionId),
            event_kind: 'tool_result',
          });
        }
      } else if (partType === 'subtask') {
        const prompt = readString(part.prompt) ?? '';
        const description = readString(part.description) ?? '';
        const agent = readString(part.agent) ?? '';
        const callId = readString(part.id) ?? `subtask-${context.turnId}-${context.sequence}`;
        if (prompt || description) {
          events.push({
            ...buildAssistantEnvelope(context, sessionId, [{
              type: 'tool_use',
              id: callId,
              name: 'Task',
              input: { prompt, description, agent },
            }]),
            event_kind: 'tool_call',
          });
        }
      }
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
      events.push(buildEnvelope({ type: 'status', subtype: statusType, status: statusType }, context, sessionId));
      break;
    }
    case 'session.idle':
      events.push(...buildResultEvents(context, 'success', sessionId));
      break;
    case 'session.error': {
      const error = properties.error ?? properties;
      const status = isInterruptedError(error) ? 'interrupted' : 'error';
      const errorText = errorMessage(error);
      process.stderr.write(`[opencode-task] toCodeMuxEvent session.error sessionId=${sessionId ?? 'null'} status=${status} error=${errorText} isInterrupted=${isInterruptedError(error)} isTimeout=${isTimeoutError(error)}\n`);
      events.push(buildEnvelope({ type: 'error', subtype: isTimeoutError(error) ? 'timeout' : status, error: errorText }, context, sessionId));
      events.push(...buildResultEvents(context, status, sessionId));
      break;
    }
    case 'permission.updated':
      events.push(buildEnvelope({ type: 'diagnostic', subtype: 'permission_request', permission_id: readString(properties.id), title: readString(properties.title) }, context, sessionId));
      break;
    case 'question.asked': {
      const questions = readArray(properties.questions);
      if (questions && questions.length > 0) {
        events.push(buildEnvelope({
          type: 'ask_user_question',
          tool_use_id: readString(properties.id) ?? `question-${context.sequence}`,
          questions: questions.map((q: unknown) => {
            const qr = asRecord(q);
            const options = Array.isArray(qr?.options) ? (qr.options as Array<Record<string, unknown>>).map((opt) => ({
              label: String(opt.label ?? ''),
              ...(opt.description ? { description: String(opt.description) } : {}),
            })) : [];
            return { question: readString(qr?.question) ?? '', header: readString(qr?.header), options };
          }),
        }, context, sessionId));
      }
      break;
    }
    case 'server.connected':
      events.push(buildEnvelope({ type: 'status', subtype: 'connected', status: 'connected' }, context, sessionId));
      break;
    case 'server.retry': {
      const retryError = properties.error;
      events.push(buildEnvelope({ type: 'status', subtype: 'retrying', status: 'retrying', ...(retryError !== undefined ? { error: errorMessage(retryError) } : {}) }, context, sessionId));
      break;
    }
    case 'server.disconnected':
    case 'server.error':
    case 'disconnect':
    case 'connection.error': {
      const error = record?.error ?? properties.error ?? record;
      events.push(buildEnvelope({ type: 'error', subtype: 'disconnected', error: errorMessage(error) }, context, sessionId));
      events.push(...buildResultEvents(context, 'error', sessionId));
      break;
    }
    case 'session.interrupted':
    case 'session.aborted':
      process.stderr.write(`[opencode-task] toCodeMuxEvent ${type} sessionId=${sessionId ?? 'null'}\n`);
      events.push(buildEnvelope({ type: 'error', subtype: 'interrupted', error: 'OpenCode session interrupted by user' }, context, sessionId));
      events.push(...buildResultEvents(context, 'interrupted', sessionId));
      break;
    default:
      events.push(buildEnvelope({ type: 'diagnostic', subtype: 'unknown_event', event_type: type }, context, sessionId));
      break;
  }

  return events.map((output, index) => ({ ...output, sequence: context.sequence + index }));
}

function buildResultEvents(context: OpenCodeEventContext, status: OpenCodeResultStatus, sessionId?: string): CodeMuxEvent[] {
  const resultContext = { ...context, agentSessionId: sessionId };
  return [{ ...buildOpenCodeResultEvent({ context: resultContext, usage: context.usage ?? emptyUsage(), durationMs: context.durationMs ?? 0, status }) as CodeMuxEvent, ...routingMetadata(context, sessionId) }];
}

function buildFailureEvents(context: OpenCodeEventContext, error: unknown, sessionId?: string): CodeMuxEvent[] {
  const status = isInterruptedError(error) ? 'interrupted' : 'error';
  return [buildEnvelope({ type: 'error', subtype: isTimeoutError(error) ? 'timeout' : status, error: errorMessage(error) }, context, sessionId), ...buildResultEvents(context, status, sessionId)];
}

function buildAssistantEnvelope(context: OpenCodeEventContext, sessionId: string | undefined, content: Array<Record<string, unknown>>): CodeMuxEvent {
  return { ...buildAssistantEvent({ sessionId: context.sessionId, content: content as AssistantContentBlock[], eventIdFactory: context.eventIdFactory }), ...routingMetadata(context, sessionId) };
}

function buildEnvelope(event: CodeMuxEvent, context: OpenCodeEventContext, sessionId: string | undefined): CodeMuxEvent {
  return { ...event, ...routingMetadata(context, sessionId), uuid: context.eventIdFactory() };
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
