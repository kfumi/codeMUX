export function buildTurnDurationMap(events: readonly unknown[]): Map<string, number> {
  const durations = new Map<string, number>();
  let activeTurn: { userId: string; startedAt?: number } | undefined;

  for (const candidate of events) {
    const event = asRecord(candidate);
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'user_message') {
      const userId = typeof event.event_id === 'string' ? event.event_id : undefined;
      activeTurn = userId
        ? { userId, startedAt: parseTimestamp(event.timestamp) }
        : undefined;
      continue;
    }

    if (type !== 'turn_finished' || !activeTurn) {
      continue;
    }

    const explicitDuration = positiveNumber(event.duration_ms);
    const completedAt = parseTimestamp(event.timestamp);
    const fallbackDuration = activeTurn.startedAt !== undefined && completedAt !== undefined
      ? completedAt - activeTurn.startedAt
      : undefined;
    const duration = explicitDuration ?? (
      fallbackDuration !== undefined && fallbackDuration > 0
        ? fallbackDuration
        : undefined
    );

    if (duration !== undefined) {
      durations.set(activeTurn.userId, duration);
    }
    activeTurn = undefined;
  }

  return durations;
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join('');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
