export interface TurnIdleGuardOptions {
  /** 0 disables the guard entirely. */
  idleTimeoutMs: number;
  onExpired?: () => void;
}

export interface TurnIdleGuard {
  /** Called on any progress event. Renews the idle window. */
  reset(): void;
  /** Called while an interactive request is pending. Stops the timer. */
  suspend(): void;
  /** Called when the interactive request resolves. Restarts the timer. */
  resume(): void;
  isExpired(): boolean;
  /** Idle window remaining; Infinity while suspended; 0 when disabled/expired. */
  remainingIdleMs(): number;
  dispose(): void;
}

export function createTurnIdleGuard(options: TurnIdleGuardOptions): TurnIdleGuard {
  const { idleTimeoutMs, onExpired } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let expired = false;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = (): void => {
    clearTimer();
    if (disposed || expired || suspended || idleTimeoutMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || suspended) return;
      expired = true;
      onExpired?.();
    }, idleTimeoutMs);
    timer.unref?.();
  };

  return {
    reset() {
      arm();
    },
    suspend() {
      suspended = true;
      clearTimer();
    },
    resume() {
      suspended = false;
      arm();
    },
    isExpired() {
      return expired;
    },
    remainingIdleMs() {
      if (disposed || expired || idleTimeoutMs <= 0) return 0;
      if (suspended) return Infinity;
      return idleTimeoutMs;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
