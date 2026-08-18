import { describe, expect, it } from 'vitest';

import { buildTurnDurationMap, formatElapsed } from './turnDuration';

describe('buildTurnDurationMap', () => {
  it('uses the completed turn duration for the visible user message', () => {
    const durations = buildTurnDurationMap([
      {
        type: 'user_message',
        event_id: 'u1',
        timestamp: '2026-08-17T15:00:00.000Z',
      },
      {
        type: 'assistant_message',
        event_id: 'a1',
        timestamp: '2026-08-17T15:00:03.000Z',
      },
      {
        type: 'turn_finished',
        duration_ms: 12_000,
        timestamp: '2026-08-17T15:00:12.000Z',
      },
    ]);

    expect(durations.get('u1')).toBe(12_000);
  });

  it('falls back to the user and completion timestamps', () => {
    const durations = buildTurnDurationMap([
      {
        type: 'user_message',
        event_id: 'u1',
        timestamp: '2026-08-17T15:00:00.000Z',
      },
      {
        type: 'turn_finished',
        timestamp: '2026-08-17T15:00:12.500Z',
      },
    ]);

    expect(durations.get('u1')).toBe(12_500);
  });

  it('uses the final completion after intermediate OpenCode results in one turn', () => {
    const durations = buildTurnDurationMap([
      {
        type: 'user_message',
        event_id: 'u1',
        timestamp: '2026-08-17T15:00:00.000Z',
      },
      {
        type: 'assistant_message',
        event_id: 'a-process-1',
      },
      {
        type: 'turn_finished',
        duration_ms: 19_000,
        timestamp: '2026-08-17T15:00:19.000Z',
      },
      {
        type: 'system_event',
        subtype: 'compact_boundary',
        timestamp: '2026-08-17T15:00:20.000Z',
      },
      {
        type: 'assistant_message',
        event_id: 'a-final',
      },
      {
        type: 'turn_finished',
        duration_ms: 55_000,
        timestamp: '2026-08-17T15:00:55.000Z',
      },
    ]);

    expect(durations.get('u1')).toBe(55_000);
  });

  it('does not start a new turn for a hidden compact summary user event', () => {
    const durations = buildTurnDurationMap([
      {
        type: 'user_message',
        event_id: 'u1',
        content: 'request',
      },
      {
        type: 'turn_finished',
        duration_ms: 19_000,
      },
      {
        type: 'user_message',
        event_id: 'compact-summary',
        content: 'This session is being continued from a previous conversation that ran out of context.',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      },
      {
        type: 'turn_finished',
        duration_ms: 55_000,
      },
    ]);

    expect(durations.get('u1')).toBe(55_000);
    expect(durations.has('compact-summary')).toBe(false);
  });
});

describe('formatElapsed', () => {
  it('matches the desktop compact duration format', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(61_000)).toBe('1m1s');
  });
});
