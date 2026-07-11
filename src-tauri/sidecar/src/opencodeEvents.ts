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
  terminalSessionIds?: ReadonlySet<string>;
  terminalToolIds?: ReadonlySet<string>;
}

export function getOpenCodeEventIdentity(event: unknown): string {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  const candidates = [record?.id, properties?.id, part?.id, part?.callID, properties?.messageID];
  const explicitId = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  if (explicitId) {
    return `${String(record?.type ?? 'unknown')}:${explicitId}:${stableStringify(event)}`;
  }
  return stableStringify(event);
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

export function extractOpenCodeUsage(event: unknown): OpenCodeTokenUsage | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const part = asRecord(properties?.part);
  const info = asRecord(properties?.info);
  const tokens = asRecord(part?.tokens) ?? asRecord(info?.tokens);
  if (!tokens) return undefined;
  const cache = asRecord(tokens.cache);
  const input = readNumber(tokens.input);
  const output = readNumber(tokens.output);
  const reasoning = readNumber(tokens.reasoning);
  const cacheRead = readNumber(cache?.read);
  const cacheWrite = readNumber(cache?.write);
  if (input === undefined && output === undefined && reasoning === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    ...(reasoning !== undefined ? { reasoning_output_tokens: reasoning } : {}),
    ...(cacheRead !== undefined ? { cached_input_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write_input_tokens: cacheWrite } : {}),
  };
}

export function toCodeMuxEvent(event: unknown, context: OpenCodeEventContext): CodeMuxEvent[] {
  const identity = getOpenCodeEventIdentity(event);
  if (context.seenEventIds?.has(identity)) return [];

  const record = asRecord(event);
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  const properties = asRecord(record?.properties) ?? {};
  const eventSessionId = getOpenCodeEventSessionId(event);
  const sessionId = eventSessionId ?? context.agentSessionId;
  if (isTerminalSessionEvent(type) && sessionId && context.terminalSessionIds?.has(sessionId)) return [];

  const events: CodeMuxEvent[] = [];
  switch (type) {
    case 'message.part.updated': {
      const part = asRecord(properties.part);
      if (!part) break;
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
        const status = readString(state?.status);
        if (status === 'pending' || status === 'running') {
          events.push({
            ...buildAssistantEnvelope(context, sessionId, [{ type: 'tool_use', id: callId, name: toolName, input: asRecord(state?.input) ?? {} }]),
            event_kind: 'tool_call',
          });
        } else if (status === 'completed' || status === 'error') {
          const rawOutput = status === 'completed' ? state?.output : state?.error;
          const output = serializeToolValue(rawOutput ?? (status === 'error' ? 'OpenCode tool failed' : ''));
          events.push({
            ...buildToolResultEvent({ sessionId: context.sessionId, toolUseId: callId, content: output, isError: status === 'error' }),
            ...routingMetadata(context, sessionId),
            event_kind: 'tool_result',
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
      events.push(buildEnvelope({ type: 'error', subtype: status, error: errorMessage(error) }, context, sessionId));
      events.push(...buildResultEvents(context, status, sessionId));
      break;
    }
    case 'permission.updated':
      events.push(buildEnvelope({ type: 'diagnostic', subtype: 'permission_request', permission_id: readString(properties.id), title: readString(properties.title) }, context, sessionId));
      break;
    case 'server.connected':
      events.push(buildEnvelope({ type: 'status', subtype: 'connected', status: 'connected' }, context, sessionId));
      break;
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
  const resultContext = sessionId ? { ...context, agentSessionId: sessionId } : context;
  return [{ ...buildOpenCodeResultEvent({ context: resultContext, usage: context.usage ?? emptyUsage(), durationMs: context.durationMs ?? 0, status }) as CodeMuxEvent, ...routingMetadata(context, sessionId) }];
}

function buildFailureEvents(context: OpenCodeEventContext, error: unknown, sessionId?: string): CodeMuxEvent[] {
  const status = isInterruptedError(error) ? 'interrupted' : 'error';
  return [buildEnvelope({ type: 'error', subtype: status, error: errorMessage(error) }, context, sessionId), ...buildResultEvents(context, status, sessionId)];
}

function buildAssistantEnvelope(context: OpenCodeEventContext, sessionId: string | undefined, content: Array<Record<string, unknown>>): CodeMuxEvent {
  return { ...buildAssistantEvent({ sessionId: context.sessionId, content: content as AssistantContentBlock[] }), ...routingMetadata(context, sessionId) };
}

function buildEnvelope(event: CodeMuxEvent, context: OpenCodeEventContext, sessionId: string | undefined): CodeMuxEvent {
  return { ...event, ...routingMetadata(context, sessionId), uuid: crypto.randomUUID() };
}

function routingMetadata(context: OpenCodeEventContext, sessionId: string | undefined): CodeMuxEvent {
  const openCodeSessionId = sessionId ?? context.agentSessionId;
  return {
    agent_id: context.agentId,
    session_id: context.sessionId,
    ...(openCodeSessionId ? { agent_session_id: openCodeSessionId, opencode_session_id: openCodeSessionId } : {}),
  };
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
