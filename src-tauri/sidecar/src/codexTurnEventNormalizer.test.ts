import { describe, expect, it } from 'vitest';
import { CodexTurnEventNormalizer } from './codexTurnEventNormalizer.js';

describe('CodexTurnEventNormalizer', () => {
  it('normalizes tool lifecycle and assigns monotonic sequences', () => {
    const normalizer = new CodexTurnEventNormalizer('session-1', () => 'event-1');

    expect(normalizer.accept({ kind: 'tool_started', toolUseId: 'tool-1', name: 'shell_command', input: { command: 'pwd' } })).toEqual([
      {
        type: 'tool_started', session_id: 'session-1', tool_use_id: 'tool-1', name: 'shell_command',
        input: { command: 'pwd' }, event_id: 'event-1', sequence: 0,
      },
    ]);
    expect(normalizer.accept({ kind: 'tool_started', toolUseId: 'tool-1', name: 'shell_command', input: {} })).toEqual([]);
    expect(normalizer.accept({ kind: 'tool_finished', toolUseId: 'tool-1', content: 'ok', isError: false })).toEqual([
      {
        type: 'tool_finished', session_id: 'session-1', tool_use_id: 'tool-1', content: 'ok',
        is_error: false, event_id: 'event-1', sequence: 1,
      },
    ]);
  });

  it('separates error reasons from the idempotent turn outcome', () => {
    const normalizer = new CodexTurnEventNormalizer('session-1', () => 'event-1');

    expect(normalizer.accept({ kind: 'error', subtype: 'runtime', message: 'network down' })[0]).toMatchObject({
      type: 'error', error: 'network down', sequence: 0,
    });
    expect(normalizer.finish({ outcome: 'failed', reason: 'network down', durationMs: 10 })).toEqual([
      {
        type: 'turn_finished', session_id: 'session-1', outcome: 'failed', reason: 'network down',
        duration_ms: 10, event_id: 'event-1', sequence: 1,
      },
    ]);
    expect(normalizer.finish({ outcome: 'completed' })).toEqual([]);
    expect(normalizer.accept({ kind: 'tool_finished', toolUseId: 'late', content: '', isError: false })).toEqual([]);
  });
});
