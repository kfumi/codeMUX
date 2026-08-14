import type { TurnOutcome } from './turnEventNormalizer.js';

export function toClaudeTurnOutcome(event: Record<string, unknown>): TurnOutcome {
  const reason = typeof event.result === 'string' && event.result.length > 0 && event.result !== 'ok'
    ? event.result
    : undefined;
  const isError = event.is_error === true || event.subtype === 'error_during_execution';

  return {
    outcome: isError ? 'failed' : 'completed',
    ...(reason ? { reason } : {}),
    ...(typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)
      ? { durationMs: event.duration_ms }
      : {}),
  };
}
