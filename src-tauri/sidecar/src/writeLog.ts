export interface LogCtx {
  sessionId?: string;
  messageId?: string;
}

/**
 * Per-event OpenCode traces. These sit on the streaming hot path — the SSE
 * reader, the event mapper and the emitter each run once per event, i.e. once
 * per text delta, and each one serialized the whole event with JSON.stringify
 * before truncating (the slice never avoided the cost, and the event carries
 * the accumulated text, so it grew with the message).
 *
 * Every stderr line is also read by the Rust backend, mutex-locked into a
 * capture buffer and logged via tracing, and writing to a pipe is synchronous
 * in Node. An ungated trace here therefore stalls the sidecar event loop and
 * breaks the 50ms stream batch cadence, which the UI renders as bursty, janky
 * updates. Same rationale as DEBUG_MESSAGE_LOGS in index.ts.
 *
 * Enable with CODEMUX_OPENCODE_DEBUG=1 when debugging event flow.
 */
export const DEBUG_OPENCODE_EVENTS = process.env.CODEMUX_OPENCODE_DEBUG === '1';

let currentCtx: LogCtx = {};

export function setLogCtx(ctx: LogCtx): void {
  currentCtx = ctx;
}

export function clearLogCtx(): void {
  currentCtx = {};
}

function ctxPrefix(): string {
  const parts: string[] = [];
  if (currentCtx.sessionId) parts.push(`session=${currentCtx.sessionId}`);
  if (currentCtx.messageId) parts.push(`msg=${currentCtx.messageId}`);
  return parts.length > 0 ? `[${parts.join('][')}]` : '';
}

export function writeLog(tag: string, message: string): void {
  const prefix = ctxPrefix();
  if (prefix) {
    process.stderr.write(`${prefix} ${tag} ${message}\n`);
  } else {
    process.stderr.write(`${tag} ${message}\n`);
  }
}
