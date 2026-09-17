import { describe, expect, it } from 'vitest';
import type { CodeMuxAssistantMessage } from './convertAgentEvents';
import { reconcileAssistantMessages } from './assistantMessageIdentity';

function textMessage(id: string, text: string, sourceEventIndex = 0): CodeMuxAssistantMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    metadata: { sourceEventIndex, sourceEventIndices: [sourceEventIndex], sourceKind: 'assistant' },
  };
}

describe('reconcileAssistantMessages', () => {
  it('returns the new list when there is nothing to reconcile against', () => {
    const next = [textMessage('a', 'hello')];
    expect(reconcileAssistantMessages(next, undefined)).toBe(next);
    expect(reconcileAssistantMessages(next, [])).toBe(next);
  });

  it('reuses identical messages and their part arrays', () => {
    const previous = [textMessage('a', 'hello'), textMessage('b', 'world', 1)];
    const next = [textMessage('a', 'hello'), textMessage('b', 'world', 1)];

    const reconciled = reconcileAssistantMessages(next, previous);

    expect(reconciled).not.toBe(next);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(previous[1]);
    expect(reconciled[0].content).toBe(previous[0].content);
  });

  it('keeps the previous content array when only metadata is rebuilt', () => {
    const previous = [textMessage('a', 'hello')];
    const next = [textMessage('a', 'hello')];
    // Same parts (by value) but a fresh array and fresh metadata object.
    expect(next[0].content).not.toBe(previous[0].content);

    const reconciled = reconcileAssistantMessages(next, previous);

    // Metadata differs by identity but is structurally equal, so the whole
    // message is reusable.
    expect(reconciled[0]).toBe(previous[0]);
  });

  it('replaces a message whose text changed', () => {
    const previous = [textMessage('a', 'hello'), textMessage('b', 'world', 1)];
    const next = [textMessage('a', 'hello'), textMessage('b', 'world!', 1)];

    const reconciled = reconcileAssistantMessages(next, previous);

    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(next[1]);
    expect(reconciled[1]).not.toBe(previous[1]);
  });

  it('reuses unchanged parts of a message that gained a tool result', () => {
    const toolCall = {
      type: 'tool-call' as const,
      toolCallId: 't1',
      toolName: 'Read',
      args: { file_path: 'a.ts' },
    };
    const previous: CodeMuxAssistantMessage[] = [{
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'reading' }, { ...toolCall }],
      metadata: { sourceEventIndex: 0, sourceEventIndices: [0], sourceKind: 'assistant' },
    }];
    const next: CodeMuxAssistantMessage[] = [{
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'reading' }, { ...toolCall, result: 'file body', isError: false }],
      metadata: { sourceEventIndex: 0, sourceEventIndices: [0], sourceKind: 'assistant' },
    }];

    const reconciled = reconcileAssistantMessages(next, previous);

    expect(reconciled[0]).not.toBe(previous[0]);
    // The unchanged leading text part keeps its identity.
    expect(reconciled[0].content[0]).toBe(previous[0].content[0]);
  });

  it('matches by id so a spliced-in message does not shift reuse', () => {
    const previous = [textMessage('a', 'one'), textMessage('c', 'three', 2)];
    const next = [textMessage('a', 'one'), textMessage('b', 'two', 1), textMessage('c', 'three', 2)];

    const reconciled = reconcileAssistantMessages(next, previous);

    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(next[1]);
    expect(reconciled[2]).toBe(previous[1]);
  });

  it('returns the fresh objects when no message id overlaps', () => {
    const previous = [textMessage('a', 'one')];
    const next = [textMessage('x', 'other')];

    const reconciled = reconcileAssistantMessages(next, previous);

    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(next[0]);
  });

  it('reuses the event part when the cloned event reference is stable', () => {
    const clonedEvent = { kind: 'error', data: { type: 'error', error: 'boom' } };
    const build = (): CodeMuxAssistantMessage => ({
      id: 'e1',
      role: 'system',
      // Same reference for both runs, mirroring cloneEventOnce's WeakMap.
      content: [{ type: 'data-codemux-event', eventKind: 'error', event: clonedEvent as never }],
      metadata: { sourceEventIndex: 0, sourceEventIndices: [0], sourceKind: 'error' },
    });

    const previous = [build()];
    const next = [build()];

    expect(reconcileAssistantMessages(next, previous)[0]).toBe(previous[0]);
  });
});
