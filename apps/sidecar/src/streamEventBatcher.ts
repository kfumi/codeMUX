import { boundEventVolume } from './boundEventVolume.js';
import { toCodeMuxStreamEvent, type CodeMuxStreamEvent } from './codeMuxProtocol.js';

const STREAM_EVENT_BATCH_INTERVAL_MS = 50;
const STREAM_EVENT_BATCH_MAX_SIZE = 100;

let pendingCodeMuxDeltas: CodeMuxStreamEvent[] = [];
let pendingTimer: NodeJS.Timeout | null = null;
const nextSequenceBySession = new Map<string, number>();
let wireSessionId: string | undefined;
const providerSessionIds = new Set<string>();

export function resetStreamEventSequences(): void {
  nextSequenceBySession.clear();
}

export function syncStreamSessionContext(options: {
  appSessionId?: string;
  providerSessionId?: string;
  clear?: boolean;
} = {}): void {
  if (options.clear) {
    wireSessionId = undefined;
    providerSessionIds.clear();
    return;
  }

  if (options.appSessionId) {
    wireSessionId = options.appSessionId;
  }
  if (options.providerSessionId) {
    providerSessionIds.add(options.providerSessionId);
  }
}

function resolveWireSessionId(eventSessionId?: string): string | undefined {
  if (!wireSessionId) {
    return eventSessionId;
  }
  if (!eventSessionId || eventSessionId === wireSessionId || providerSessionIds.has(eventSessionId)) {
    return wireSessionId;
  }
  return eventSessionId;
}

function withResolvedSessionId(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const event = value as Record<string, unknown>;
  const eventSessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
  const resolvedSessionId = resolveWireSessionId(eventSessionId);
  if (!resolvedSessionId || resolvedSessionId === eventSessionId) {
    return value;
  }

  return { ...event, session_id: resolvedSessionId };
}

function writeJsonLine(obj: unknown): void {
  // Single volume chokepoint for everything the sidecar sends to the daemon:
  // bounding here means the persisted copy and the broadcast copy are derived
  // from the same already-truncated JSON, so they cannot disagree.
  process.stdout.write(JSON.stringify(boundEventVolume(obj)) + '\n');
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
  const resolved = withResolvedSessionId(obj);

  if (isBatchableCodeMuxDelta(resolved)) {
    queueCodeMuxEvent(withCodeMuxEnvelope(resolved) as CodeMuxStreamEvent);
    return;
  }

  if (resolved && typeof resolved === 'object' && (resolved as { type?: unknown }).type === 'stream_event') {
    const streamEnvelope = resolved as { type: 'stream_event'; session_id?: string; event: unknown };
    const sessionId = resolveWireSessionId(streamEnvelope.session_id);
    const codeMuxEvent = toCodeMuxStreamEvent(sessionId, streamEnvelope.event);
    if (codeMuxEvent) {
      queueCodeMuxEvent(withCodeMuxEnvelope(codeMuxEvent) as CodeMuxStreamEvent);
      return;
    }

    // These are valid Anthropic stream control/signature events. They have no
    // transcript projection, so turning them into diagnostics would append
    // one history event per provider frame.
    if (isExpectedProviderStreamEvent(streamEnvelope.event)) {
      return;
    }

    flushCodeMuxDeltas();
    writeJsonLine(withCodeMuxEnvelope({
      type: 'diagnostic',
      subtype: 'unsupported_stream_event',
      session_id: sessionId ?? streamEnvelope.session_id,
    }));
    return;
  }

  flushStreamEvents();
  writeJsonLine(withCodeMuxEnvelope(resolved));
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
    && ((value as { type?: unknown }).type === 'text_delta'
      || (value as { type?: unknown }).type === 'reasoning_delta'
      || (value as { type?: unknown }).type === 'tool_input_delta');
}

function isExpectedProviderStreamEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  if (type === 'message_start' || type === 'message_delta' || type === 'message_stop') {
    return true;
  }

  // content_block_delta is a known event even when its nested delta is a
  // signature/citation variant that the UI does not render.
  return type === 'content_block_delta';
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
  const timestamp = typeof event.timestamp === 'string' && event.timestamp.length > 0
    ? event.timestamp
    : new Date().toISOString();
  return {
    ...wireEvent,
    event_id: eventId,
    timestamp,
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

function isCodeMuxDomainEvent(type: unknown): boolean {
  return type === 'content_started'
    || type === 'text_delta'
    || type === 'reasoning_delta'
    || type === 'tool_input_delta'
    || type === 'content_finished'
    || type === 'user_message'
    || type === 'assistant_message'
    || type === 'tool_started'
    || type === 'tool_finished'
    || type === 'user_input_requested'
    || type === 'permission_requested'
    || type === 'permission_resolved'
    || type === 'permission_mode_changed'
    || type === 'system_event'
    || type === 'diagnostic'
    || type === 'error'
    || type === 'turn_finished';
}
