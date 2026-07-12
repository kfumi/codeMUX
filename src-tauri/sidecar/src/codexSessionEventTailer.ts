import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexSessionTailEvent =
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

type CodexSessionEventTailerOptions = {
  threadId: string;
  onEvent: (event: CodexSessionTailEvent) => void;
  sessionsRoot?: string;
  skipExisting?: boolean;
};

export class CodexSessionEventTailer {
  private readonly threadId: string;
  private readonly onEvent: (event: CodexSessionTailEvent) => void;
  private readonly sessionsRoot: string;
  private readonly skipExisting: boolean;
  private sessionFile: string | null = null;
  private offset = 0;

  constructor(options: CodexSessionEventTailerOptions) {
    this.threadId = options.threadId;
    this.onEvent = options.onEvent;
    this.sessionsRoot = options.sessionsRoot ?? join(homedir(), '.codex', 'sessions');
    this.skipExisting = options.skipExisting ?? true;
  }

  async start(): Promise<void> {
    await this.ensureSessionFile();
    if (this.skipExisting && this.sessionFile) {
      this.offset = (await stat(this.sessionFile)).size;
    }
  }

  async pollOnce(): Promise<void> {
    await this.ensureSessionFile();
    if (!this.sessionFile) {
      return;
    }

    const sessionStats = await stat(this.sessionFile);
    if (sessionStats.size < this.offset) {
      this.offset = 0;
    }
    if (sessionStats.size === this.offset) {
      return;
    }

    const pending = await readAppendedBytes(this.sessionFile, this.offset, sessionStats.size);
    const lastNewline = pending.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return;
    }

    const complete = pending.subarray(0, lastNewline + 1);
    this.offset += complete.length;
    for (const line of complete.toString('utf8').split(/\r?\n/)) {
      const event = parseCodexSessionLine(line);
      if (event) {
        this.onEvent(event);
      }
    }
  }

  private async ensureSessionFile(): Promise<void> {
    if (this.sessionFile) {
      return;
    }
    this.sessionFile = await findCodexSessionFile(this.sessionsRoot, this.threadId);
  }
}

async function readAppendedBytes(path: string, offset: number, size: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function parseCodexSessionLine(line: string): CodexSessionTailEvent | null {
  const value = parseRecord(line);
  if (!value || value.type !== 'response_item') {
    return null;
  }

  const payload = asRecord(value.payload);
  if (!payload || typeof payload.type !== 'string') {
    return null;
  }

  switch (payload.type) {
    case 'function_call':
      return parseToolUse(payload, 'arguments');
    case 'custom_tool_call':
      return parseToolUse(payload, 'input');
    case 'function_call_output':
    case 'custom_tool_call_output':
      return parseToolResult(payload);
    default:
      return null;
  }
}

async function findCodexSessionFile(root: string, threadId: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCodexSessionFile(path, threadId);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    if (await sessionFileMatches(path, threadId)) {
      return path;
    }
  }

  return null;
}

async function sessionFileMatches(path: string, threadId: string): Promise<boolean> {
  try {
    const contents = await readFile(path, 'utf8');
    const firstLine = contents.split(/\r?\n/, 1)[0] ?? '';
    const firstEvent = parseRecord(firstLine);
    return firstEvent?.type === 'session_meta'
      && asRecord(firstEvent.payload)?.id === threadId;
  } catch {
    return false;
  }
}

function parseToolUse(payload: Record<string, unknown>, argumentKey: 'arguments' | 'input'): CodexSessionTailEvent | null {
  const id = readNonEmptyString(payload.call_id);
  const name = readNonEmptyString(payload.name);
  if (!id || !name) {
    return null;
  }

  return {
    type: 'tool_use',
    id,
    name,
    input: parseToolInput(payload[argumentKey]),
  };
}

function parseToolResult(payload: Record<string, unknown>): CodexSessionTailEvent | null {
  const toolUseId = readNonEmptyString(payload.call_id);
  if (!toolUseId) {
    return null;
  }

  return {
    type: 'tool_result',
    toolUseId,
    content: stringifyValue(payload.output),
    isError: payload.is_error === true || payload.error === true,
  };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseRecord(value);
    return parsed ?? { raw: value };
  }
  return value == null ? {} : { input: value };
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return isRecord(value) ? value : null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
