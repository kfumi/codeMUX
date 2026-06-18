import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { readLatestCodexLastTokenUsage } from './codexSessionUsage.js';

describe('readLatestCodexLastTokenUsage', () => {
  it('reads the last token_count.info.last_token_usage for a Codex thread', async () => {
    const root = join(tmpdir(), `codemux-codex-usage-${crypto.randomUUID()}`);
    const sessionDir = join(root, '2026', '06', '18');
    const sessionFile = join(sessionDir, 'rollout.jsonl');
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 100,
                output_tokens: 200,
                total_tokens: 1300,
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 1,
                output_tokens: 2,
                reasoning_output_tokens: 3,
                total_tokens: 13,
              },
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 2000,
                cached_input_tokens: 200,
                output_tokens: 400,
                total_tokens: 2600,
              },
              last_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 2,
                output_tokens: 4,
                reasoning_output_tokens: 6,
                total_tokens: 26,
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    try {
      await expect(readLatestCodexLastTokenUsage('thread-1', root)).resolves.toEqual({
        input_tokens: 20,
        cached_input_tokens: 2,
        output_tokens: 4,
        reasoning_output_tokens: 6,
        total_tokens: 26,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
