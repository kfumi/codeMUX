import { toCodeMuxStreamEvent, type CodeMuxStreamEvent } from './codeMuxProtocol.js';

const STREAM_EVENT_BATCH_INTERVAL_MS = 50;
const STREAM_EVENT_BATCH_MAX_SIZE = 100;

type StreamEventEnvelope = {
  type: 'stream_event';
  session_id?: string;
  event: unknown;
};

let pendingStreamEvents: StreamEventEnvelope[] = [];
let pendingCodeMuxDeltas: CodeMuxStreamEvent[] = [];
let pendingTimer: NodeJS.Timeout | null = null;

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

  flushLegacyStreamEvents();
  flushCodeMuxDeltas();
}

export function emit(obj: unknown): void {
  if (isBatchableCodeMuxDelta(obj)) {
    queueCodeMuxEvent(obj);
    return;
  }

  if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'stream_event') {
    const streamEnvelope = obj as StreamEventEnvelope;
    const codeMuxEvent = toCodeMuxStreamEvent(streamEnvelope.session_id, streamEnvelope.event);
    if (codeMuxEvent) {
      queueCodeMuxEvent(codeMuxEvent);
      return;
    }

    flushCodeMuxDeltas();
    pendingStreamEvents.push(streamEnvelope);
    if (pendingStreamEvents.length >= STREAM_EVENT_BATCH_MAX_SIZE) flushStreamEvents();
    else scheduleFlush();
    return;
  }

  flushStreamEvents();
  writeJsonLine(obj);
}

function queueCodeMuxEvent(event: CodeMuxStreamEvent): void {
  if (!isBatchableCodeMuxDelta(event)) {
    flushStreamEvents();
    writeJsonLine(event);
    return;
  }

  flushLegacyStreamEvents();
  pendingCodeMuxDeltas.push(event);
  if (pendingCodeMuxDeltas.length >= STREAM_EVENT_BATCH_MAX_SIZE) flushStreamEvents();
  else scheduleFlush();
}

function flushLegacyStreamEvents(): void {
  if (pendingStreamEvents.length === 0) return;
  const batch = pendingStreamEvents;
  pendingStreamEvents = [];
  writeJsonLine({
    type: 'stream_event_batch',
    session_id: batch[0]?.session_id,
    events: batch.map((item) => item.event),
  });
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
