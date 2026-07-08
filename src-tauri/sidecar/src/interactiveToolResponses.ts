type PendingInteractiveToolResponse = {
  sessionId?: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
};

const pendingInteractiveToolResponses = new Map<string, PendingInteractiveToolResponse>();

export type InteractiveToolResponseWaitOptions = {
  sessionId?: string;
  timeoutMs?: number;
};

export function waitForInteractiveToolResponse(
  toolUseId: string,
  options: InteractiveToolResponseWaitOptions = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    const pending: PendingInteractiveToolResponse = {
      sessionId: options.sessionId,
      resolve,
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      pending.timeoutTimer = setTimeout(() => {
        expireInteractiveToolResponse(toolUseId);
      }, options.timeoutMs);
      if (pending.timeoutTimer.unref) pending.timeoutTimer.unref();
    }
    pendingInteractiveToolResponses.set(toolUseId, pending);
  });
}

export function resolveInteractiveToolResponse(toolUseId: string, response: unknown): boolean {
  const pending = pendingInteractiveToolResponses.get(toolUseId);
  if (!pending) {
    return false;
  }

  pendingInteractiveToolResponses.delete(toolUseId);
  if (pending.timeoutTimer) {
    clearTimeout(pending.timeoutTimer);
  }
  pending.resolve(response);
  return true;
}

export function expireInteractiveToolResponse(toolUseId: string): boolean {
  const pending = pendingInteractiveToolResponses.get(toolUseId);
  if (!pending) {
    return false;
  }

  pendingInteractiveToolResponses.delete(toolUseId);
  if (pending.timeoutTimer) {
    clearTimeout(pending.timeoutTimer);
  }
  pending.resolve(buildInteractiveToolTimeoutResponse());
  return true;
}

export function expireInteractiveToolResponses(sessionId?: string, _message?: string): number {
  let expired = 0;
  for (const [toolUseId, pending] of Array.from(pendingInteractiveToolResponses.entries())) {
    if (sessionId && pending.sessionId !== sessionId) {
      continue;
    }
    if (expireInteractiveToolResponse(toolUseId)) {
      expired += 1;
    }
  }
  return expired;
}

export function clearInteractiveToolResponses(sessionId?: string): number {
  let cleared = 0;
  for (const [toolUseId, pending] of Array.from(pendingInteractiveToolResponses.entries())) {
    if (sessionId && pending.sessionId !== sessionId) {
      continue;
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pendingInteractiveToolResponses.delete(toolUseId);
    cleared += 1;
  }
  return cleared;
}

export function buildInteractiveToolTimeoutResponse(): Record<string, unknown> {
  return {
    answers: {},
    cancelled: true,
    reason_code: 'user_input_timeout',
  };
}

export function isInteractiveToolTimeoutResponse(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { reason_code?: unknown }).reason_code === 'user_input_timeout'
  );
}
