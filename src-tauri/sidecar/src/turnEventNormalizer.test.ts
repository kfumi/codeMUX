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

  it('drops duplicate Claude assistant snapshots by provider message id', () => {
    let eventNumber = 0;
    const normalizer = new TurnEventNormalizer('session-1', () => `event-${++eventNumber}`);

    const first = normalizer.accept({
      kind: 'assistant_message',
      providerMessageId: 'claude-message-1',
      content: [{ type: 'text', text: 'same snapshot' }],
    });
    const duplicate = normalizer.accept({
      kind: 'assistant_message',
      providerMessageId: 'claude-message-1',
      content: [{ type: 'text', text: 'same snapshot' }],
    });

    expect(first).toHaveLength(1);
    expect(duplicate).toEqual([]);
  });

  it('keeps supersedes metadata for a newer Claude assistant snapshot', () => {
    const normalizer = new TurnEventNormalizer('session-1', () => 'event-2');

    expect(normalizer.accept({
      kind: 'assistant_message',
      providerMessageId: 'claude-message-2',
      supersedesProviderMessageIds: ['claude-message-1'],
      content: [{ type: 'text', text: 'new snapshot' }],
    })).toEqual([expect.objectContaining({
      provider_message_id: 'claude-message-2',
      supersedes_provider_message_ids: ['claude-message-1'],
    })]);
  });
});
