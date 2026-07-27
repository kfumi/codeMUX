import type { TurnOutcome } from './turnEventNormalizer.js';

export function toClaudeTurnOutcome(event: Record<string, unknown>): TurnOutcome {
  const rawUsage = event.usage;
  const usage = typeof rawUsage === 'object' && rawUsage !== null && !Array.isArray(rawUsage)
    ? rawUsage as Record<string, unknown>
    : null;
  const normalizedUsage = usage
    ? {
        input_tokens: readFiniteNumber(usage.input_tokens),
        output_tokens: readFiniteNumber(usage.output_tokens),
        cached_input_tokens: readFiniteNumber(usage.cache_read_input_tokens ?? usage.cached_input_tokens),
        reasoning_output_tokens: readFiniteNumber(usage.reasoning_output_tokens),
      }
    : null;
  const hasUsage = normalizedUsage
    && (normalizedUsage.input_tokens > 0
      || normalizedUsage.output_tokens > 0
      || normalizedUsage.cached_input_tokens > 0
      || normalizedUsage.reasoning_output_tokens > 0);
  const reason = typeof event.result === 'string' && event.result.length > 0 && event.result !== 'ok'
    ? event.result
    : undefined;
  const isError = event.is_error === true || event.subtype === 'error_during_execution';

  return {
    outcome: isError ? 'failed' : 'completed',
    ...(reason ? { reason } : {}),
    ...(hasUsage ? { usage: normalizedUsage } : {}),
    ...(typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)
      ? { durationMs: event.duration_ms }
      : {}),
  };
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
