export interface TurnTimeouts {
  idle_timeout_ms?: number;
  approval_timeout_ms?: number;
  question_timeout_ms?: number;
}

export interface ResolvedTurnTimeouts {
  idle_timeout_ms: number;
  approval_timeout_ms: number;
  question_timeout_ms: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** 0 disables the timeout (infinite wait / no idle kill). */
export function resolveTurnTimeouts(configured?: TurnTimeouts): ResolvedTurnTimeouts {
  return {
    idle_timeout_ms:
      configured?.idle_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_IDLE_TIMEOUT_MS')
      ?? DEFAULT_IDLE_TIMEOUT_MS,
    approval_timeout_ms:
      configured?.approval_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_APPROVAL_TIMEOUT_MS')
      ?? 0,
    question_timeout_ms:
      configured?.question_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_QUESTION_TIMEOUT_MS')
      ?? 0,
  };
}

function readEnvTimeoutMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(`[sidecar] Ignoring invalid ${name}=${raw}; expected a non-negative integer of milliseconds\n`);
    return undefined;
  }
  return parsed;
}
