export interface LogCtx {
  sessionId?: string;
  messageId?: string;
}

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
