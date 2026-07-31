import { describe, expect, it } from 'vitest';

import { TurnEventNormalizer } from './turnEventNormalizer.js';

describe('TurnEventNormalizer', () => {
  it('preserves Claude assistant stop_reason in the normalized event', () => {
    const normalizer = new TurnEventNormalizer('session-1', () => 'event-1');

    expect(normalizer.accept({
      kind: 'assistant_message',
      content: [{ type: 'text', text: 'final answer' }],
      stopReason: 'end_turn',
    })).toEqual([{
      type: 'assistant_message',
      session_id: 'session-1',
      content: [{ type: 'text', text: 'final answer' }],
      stop_reason: 'end_turn',
      event_id: 'event-1',
      sequence: 0,
    }]);
  });
});
