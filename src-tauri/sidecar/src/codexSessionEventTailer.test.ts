import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexSessionEventTailer } from './codexSessionEventTailer.js';

describe('CodexSessionEventTailer', () => {
  it('emits function calls and results appended after the current cursor', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'codemux-codex-tail-'));
    const sessionDir = path.join(sessionsRoot, '2026', '07', '13');
    const sessionFile = path.join(sessionDir, 'rollout-test.jsonl');
    const events: unknown[] = [];

    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(sessionFile, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-1' },
      })}\n`, { encoding: 'utf8', flush: true });

      const tailer = new CodexSessionEventTailer({
        threadId: 'thread-1',
        sessionsRoot,
        skipExisting: true,
        onEvent: (event) => events.push(event),
      });
      await tailer.start();

      await appendFile(sessionFile, [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-spawn',
            name: 'spawn_agent',
            arguments: '{"description":"Inspect tests"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-spawn',
            output: 'completed',
          },
        }),
        '',
      ].join('\n'), 'utf8');

      await tailer.pollOnce();

      expect(events).toEqual([
        {
          type: 'tool_use',
          id: 'call-spawn',
          name: 'spawn_agent',
          input: { description: 'Inspect tests' },
        },
        {
          type: 'tool_result',
          toolUseId: 'call-spawn',
          content: 'completed',
          isError: false,
        },
      ]);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });
});