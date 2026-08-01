import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextWithTimeout } from './claudeQueryTimeout.js';

describe('nextWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the idle timer when the iterator returns first', async () => {
    vi.useFakeTimers();

    const result = await nextWithTimeout(
      async () => ({ done: false, value: 'message' }),
      300_000,
      () => {
        throw new Error('timed out');
      },
    );

    expect(result).toEqual({ done: false, value: 'message' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on timeout and does not leave the timer behind', async () => {
    vi.useFakeTimers();
    const next = new Promise<string>(() => undefined);
    const pending = nextWithTimeout(
      () => next,
      1_000,
      () => {
        throw new Error('timed out');
      },
    );

    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
