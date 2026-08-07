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

  it('waits indefinitely when timeoutMs is 0 (disabled idle timeout)', async () => {
    vi.useFakeTimers();
    let resolveNext!: (value: string) => void;
    const next = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveNext = resolve;
      }),
    );
    const promise = nextWithTimeout(next, 0, () => 'timeout');
    expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    resolveNext('later');
    await expect(promise).resolves.toBe('later');
  });

  it('waits indefinitely when timeoutMs is Infinity (suspended idle guard)', async () => {
    vi.useFakeTimers();
    let resolveNext!: (value: string) => void;
    const next = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveNext = resolve;
      }),
    );
    const promise = nextWithTimeout(next, Infinity, () => 'timeout');
    expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    resolveNext('later');
    await expect(promise).resolves.toBe('later');
  });

  it('still races additionalPromises when timeoutMs is 0 (compact timeout preserved)', async () => {
    vi.useFakeTimers();
    let resolveNext!: (value: string) => void;
    const next = vi.fn().mockReturnValue(new Promise<string>((resolve) => {
      resolveNext = resolve;
    }));
    const compact = new Promise<string>((resolve) => {
      setTimeout(() => resolve('compact'), 30);
    });
    const promise = nextWithTimeout(next, 0, () => 'timeout', [compact]);
    await vi.advanceTimersByTimeAsync(40);
    await expect(promise).resolves.toBe('compact');
    resolveNext('later');
  });
});
