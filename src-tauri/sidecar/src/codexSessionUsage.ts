import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

import type { CodexTokenUsage } from './runtimeEvents.js';

export async function readLatestCodexLastTokenUsage(
  threadId: string | null | undefined,
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
): Promise<CodexTokenUsage | null> {
  return readLatestCodexTokenUsage(threadId, 'last_token_usage', sessionsRoot);
}

export async function readLatestCodexTotalTokenUsage(
  threadId: string | null | undefined,
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
): Promise<CodexTokenUsage | null> {
  return readLatestCodexTokenUsage(threadId, 'total_token_usage', sessionsRoot);
}

async function readLatestCodexTokenUsage(
  threadId: string | null | undefined,
  usageKey: 'last_token_usage' | 'total_token_usage',
  sessionsRoot: string,
): Promise<CodexTokenUsage | null> {
  if (!threadId) {
    return null;
  }

  const sessionFile = await findCodexSessionFile(sessionsRoot, threadId);
  if (!sessionFile) {
    return null;
  }

  let latestUsage: CodexTokenUsage | null = null;
  const rl = createInterface({
    input: createReadStream(sessionFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const value = parseJsonObject(trimmed);
    const usage = value?.type === 'event_msg' && isRecord(value.payload)
      ? readTokenUsage(value.payload, usageKey)
      : null;
    if (usage) {
      latestUsage = usage;
    }
  }

  return latestUsage;
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
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const value = parseJsonObject(trimmed);
      return value?.type === 'session_meta' &&
        isRecord(value.payload) &&
        value.payload.id === threadId;
    }
  } finally {
    rl.close();
  }

  return false;
}

function readTokenUsage(
  payload: Record<string, unknown>,
  usageKey: 'last_token_usage' | 'total_token_usage',
): CodexTokenUsage | null {
  if (payload.type !== 'token_count' || !isRecord(payload.info)) {
    return null;
  }

  const usage = payload.info[usageKey];
  if (!isRecord(usage)) {
    return null;
  }

  const input = readNumber(usage.input_tokens);
  const cached = readNumber(usage.cached_input_tokens);
  const output = readNumber(usage.output_tokens);
  const reasoning = readNumber(usage.reasoning_output_tokens);

  if (input === 0 && cached === 0 && output === 0) {
    return null;
  }

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output + reasoning,
  };
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
