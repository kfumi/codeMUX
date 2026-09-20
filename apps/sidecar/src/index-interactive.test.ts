import { describe, expect, it, vi } from 'vitest';
import {
  expireClaudeToolResponses,
  resolveClaudeToolResponse,
  waitForClaudeToolResponse,
} from './index.js';

describe('Claude interactive response waits', () => {
  it('waits indefinitely when timeoutMs is 0 (default approval/question)', async () => {
    const pending = waitForClaudeToolResponse('tool-1', 'session-1', 0);
    const outcome = pending.then((result) => result);
    expect(resolveClaudeToolResponse('tool-1', 'once')).toBe(true);
    await expect(outcome).resolves.toEqual({ kind: 'answered', value: 'once' });
  });

  it('expires after a configured timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForClaudeToolResponse('tool-2', 'session-1', 25);
      const outcome = pending.then((result) => result);
      await vi.advanceTimersByTimeAsync(26);
      await expect(outcome).resolves.toEqual({ kind: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires all pending responses for a session on reset', async () => {
    const pending = waitForClaudeToolResponse('tool-3', 'session-1', 0);
    const outcome = pending.then((result) => result);
    expect(expireClaudeToolResponses('session-1')).toBe(1);
    await expect(outcome).resolves.toEqual({ kind: 'expired' });
  });
});
