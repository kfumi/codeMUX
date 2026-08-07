import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnIdleGuard } from './turnIdleGuard.js';

describe('createTurnIdleGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExpired after the idle window without progress', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(24);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.isExpired()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(guard.isExpired()).toBe(true);
    expect(guard.remainingIdleMs()).toBe(0);
  });

  it('reset() renews the idle window', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('suspend() stops the timer and resume() restarts it from now', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    guard.suspend();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.remainingIdleMs()).toBe(Infinity);
    guard.resume();
    await vi.advanceTimersByTimeAsync(20);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('never expires when idleTimeoutMs is 0 (disabled)', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 0, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.remainingIdleMs()).toBe(0);
  });

  it('dispose() prevents any later expiration', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    guard.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
