import { toCodeMuxStreamEvent, type CodeMuxStreamEvent } from './codeMuxProtocol.js';

const STREAM_EVENT_BATCH_INTERVAL_MS = 50;
const STREAM_EVENT_BATCH_MAX_SIZE = 100;

let pendingCodeMuxDeltas: CodeMuxStreamEvent[] = [];
let pendingTimer: NodeJS.Timeout | null = null;
const nextSequenceBySession = new Map<string, number>();

export function resetStreamEventSequences(): void {
  nextSequenceBySession.clear();
}

function writeJsonLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function scheduleFlush(): void {
  if (pendingTimer) {
    return;
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flushStreamEvents();
  }, STREAM_EVENT_BATCH_INTERVAL_MS);
  pendingTimer.unref?.();
}

export function flushStreamEvents(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  flushCodeMuxDeltas();
}

export function emit(obj: unknown): void {
  if (isBatchableCodeMuxDelta(obj)) {
    queueCodeMuxEvent(withCodeMuxEnvelope(obj) as CodeMuxStreamEvent);
    return;
  }

  if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'stream_event') {
    const streamEnvelope = obj as { type: 'stream_event'; session_id?: string; event: unknown };
    const codeMuxEvent = toCodeMuxStreamEvent(streamEnvelope.session_id, streamEnvelope.event);
    if (codeMuxEvent) {
      queueCodeMuxEvent(withCodeMuxEnvelope(codeMuxEvent) as CodeMuxStreamEvent);
      return;
    }

    flushCodeMuxDeltas();
    writeJsonLine(withCodeMuxEnvelope({
      type: 'diagnostic',
      subtype: 'unsupported_stream_event',
      session_id: streamEnvelope.session_id,
    }));
    return;
  }

  flushStreamEvents();
  writeJsonLine(withCodeMuxEnvelope(obj));
}

function queueCodeMuxEvent(event: CodeMuxStreamEvent): void {
  if (!isBatchableCodeMuxDelta(event)) {
    flushStreamEvents();
    writeJsonLine(event);
    return;
  }

  pendingCodeMuxDeltas.push(event);
  if (pendingCodeMuxDeltas.length >= STREAM_EVENT_BATCH_MAX_SIZE) flushStreamEvents();
  else scheduleFlush();
}

function flushCodeMuxDeltas(): void {
  if (pendingCodeMuxDeltas.length === 0) return;
  const batch = pendingCodeMuxDeltas;
  pendingCodeMuxDeltas = [];
  writeJsonLine({ type: 'codemux_event_batch', session_id: batch[0]?.session_id, events: batch });
}

function isBatchableCodeMuxDelta(value: unknown): value is CodeMuxStreamEvent {
  return Boolean(value)
    && typeof value === 'object'
    && ((value as { type?: unknown }).type === 'text_delta' || (value as { type?: unknown }).type === 'reasoning_delta');
}

function withCodeMuxEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const event = value as Record<string, unknown>;
  if (!isCodeMuxDomainEvent(event.type)) {
    return value;
  }

  const sessionId = typeof event.session_id === 'string' && event.session_id.length > 0
    ? event.session_id
    : undefined;
  const eventId = typeof event.event_id === 'string' && event.event_id.length > 0
    ? event.event_id
    : typeof event.uuid === 'string' && event.uuid.length > 0
      ? event.uuid
      : crypto.randomUUID();
  // Runtime normalizers may restart their local counter for each turn. The
  // transport owns the session-wide sequence so every provider shares one
  // monotonic ordering at the wire seam.
  const sequence = sessionId
    ? nextSequenceBySession.get(sessionId) ?? 0
    : typeof event.sequence === 'number' && Number.isFinite(event.sequence)
      ? event.sequence
      : undefined;

  if (sessionId && sequence !== undefined) {
    nextSequenceBySession.set(sessionId, Math.max(nextSequenceBySession.get(sessionId) ?? 0, sequence + 1));
  }

  const { event: _legacyEvent, ...wireEvent } = event;
  return {
    ...wireEvent,
    event_id: eventId,
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

function isCodeMuxDomainEvent(type: unknown): boolean {
  return type === 'content_started'
    || type === 'text_delta'
    || type === 'reasoning_delta'
    || type === 'content_finished'
    || type === 'user_message'
    || type === 'assistant_message'
    || type === 'tool_started'
    || type === 'tool_finished'
    || type === 'user_input_requested'
    || type === 'permission_requested'
    || type === 'system_event'
    || type === 'diagnostic'
    || type === 'error'
    || type === 'turn_finished';
}
