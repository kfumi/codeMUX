const STREAM_EVENT_BATCH_INTERVAL_MS = 50;
const STREAM_EVENT_BATCH_MAX_SIZE = 100;

type StreamEventEnvelope = {
  type: 'stream_event';
  session_id?: string;
  event: unknown;
};

let pendingStreamEvents: StreamEventEnvelope[] = [];
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

  if (pendingStreamEvents.length === 0) {
    return;
  }

  const batch = pendingStreamEvents;
  pendingStreamEvents = [];
  const sessionId = batch[0]?.session_id;
  writeJsonLine({
    type: 'stream_event_batch',
    session_id: sessionId,
    events: batch.map((item) => item.event),
  });
}

export function emit(obj: unknown): void {
  if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'stream_event') {
    pendingStreamEvents.push(obj as StreamEventEnvelope);
    if (pendingStreamEvents.length >= STREAM_EVENT_BATCH_MAX_SIZE) {
      flushStreamEvents();
    } else {
      scheduleFlush();
    }
    return;
  }

  flushStreamEvents();
  writeJsonLine(obj);
}
