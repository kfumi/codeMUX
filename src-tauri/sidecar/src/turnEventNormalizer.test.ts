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

describe('TurnEventNormalizer tool input refresh', () => {
  const initialToolStart = {
    kind: 'tool_started' as const,
    toolUseId: 'call-1',
    name: 'read',
    input: {},
  };
  const fullerToolStart = {
    kind: 'tool_started' as const,
    toolUseId: 'call-1',
    name: 'read',
    input: { file_path: 'D:/demo/package.json' },
  };

  it('drops repeated tool_started by default', () => {
    const normalizer = new TurnEventNormalizer('session-1', () => 'event-1');
    expect(normalizer.accept(initialToolStart)).toHaveLength(1);
    expect(normalizer.accept(fullerToolStart)).toEqual([]);
  });

  it('re-emits a merged tool_started when refreshToolInput is enabled', () => {
    let eventNumber = 0;
    const normalizer = new TurnEventNormalizer('session-1', () => `event-${++eventNumber}`, { refreshToolInput: true });
    expect(normalizer.accept(initialToolStart)).toHaveLength(1);
    const refreshed = normalizer.accept(fullerToolStart);
    expect(refreshed).toEqual([expect.objectContaining({
      type: 'tool_started',
      tool_use_id: 'call-1',
      input: { file_path: 'D:/demo/package.json' },
    })]);
    // A repeated identical update emits nothing.
    expect(normalizer.accept(fullerToolStart)).toEqual([]);
    // Partial updates merge over the stored input instead of replacing it.
    expect(normalizer.accept({ ...fullerToolStart, input: { offset: 10 } })).toEqual([
      expect.objectContaining({
        input: { file_path: 'D:/demo/package.json', offset: 10 },
      }),
    ]);
  });
});
