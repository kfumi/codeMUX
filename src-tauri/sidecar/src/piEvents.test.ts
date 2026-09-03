import { describe, expect, it } from 'vitest';

import { createPiEventContext, toCodeMuxEvents } from './piEvents.js';

function createContext() {
  let id = 0;
  return createPiEventContext({
    sessionId: 'app-session',
    eventIdFactory: () => `evt-${++id}`,
  });
}

const BASE = { agent_id: 'pi', session_id: 'app-session' };

describe('piEvents text/thinking streaming', () => {
  it('opens a text block on the first text_delta and streams deltas', () => {
    const ctx = createContext();
    const first = toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }, ctx);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ ...BASE, type: 'content_started', index: 0, content_kind: 'text', event_id: 'evt-1' });
    expect(first[1]).toMatchObject({ ...BASE, type: 'text_delta', index: 0, text: 'Hello', event_id: 'evt-2' });

    const second = toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } }, ctx);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'text_delta', index: 0, text: ' world' });
  });

  it('opens a separate reasoning block and finishes blocks on end events', () => {
    const ctx = createContext();
    const events = [
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'done' } }, ctx),
    ];
    expect(events.map((event) => event.type)).toEqual([
      'content_started',
      'reasoning_delta',
      'content_finished',
      'content_started',
      'text_delta',
      'content_finished',
    ]);
    expect(events[1]?.type === 'reasoning_delta' && (events[1] as { index: number }).index === 0).toBe(true);
    expect(events[4]).toMatchObject({ index: 1, text: 'answer' });
  });

  it('emits assistant_message on message_end with mapped content blocks', () => {
    const ctx = createContext();
    const events = toCodeMuxEvents(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'done' },
            { type: 'thinking', thinking: 'why' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
          stopReason: 'stop',
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ...BASE, type: 'assistant_message' });
    const content = (events[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'thinking', thinking: 'why' },
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.ts' } },
    ]);
  });
});

describe('piEvents COMPAT cumulative message_update', () => {
  it('projects the missing suffix when pi repeats the cumulative message', () => {
    const ctx = createContext();
    const first = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'AB' }] } },
      ctx,
    );
    expect(first).toEqual([
      expect.objectContaining({ type: 'content_started', content_kind: 'text' }),
      expect.objectContaining({ type: 'text_delta', text: 'AB' }),
    ]);

    const second = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ABCD' }] } },
      ctx,
    );
    expect(second).toEqual([expect.objectContaining({ type: 'text_delta', text: 'CD' })]);

    const third = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ABCD' }] } },
      ctx,
    );
    expect(third).toEqual([]);
  });
});

describe('piEvents tool execution', () => {
  it('maps tool start/end by toolCallId and surfaces errors', () => {
    const ctx = createContext();
    const start = toCodeMuxEvents(
      { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'bash', args: { command: 'ls' } },
      ctx,
    );
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ ...BASE, type: 'tool_started', tool_use_id: 'call-9', name: 'bash', input: { command: 'ls' } });

    const end = toCodeMuxEvents(
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'bash', result: 'file.ts', isError: false },
      ctx,
    );
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: 'tool_finished', tool_use_id: 'call-9', content: 'file.ts', is_error: false });

    const failed = toCodeMuxEvents(
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'bash', result: { message: 'boom' }, isError: true },
      ctx,
    );
    expect(failed[0]).toMatchObject({ type: 'tool_finished', is_error: true, content: '{"message":"boom"}' });
  });

  it('ignores lifecycle and unsupported events without output', () => {
    const ctx = createContext();
    for (const event of [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'agent_settled' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'tool_execution_update', toolCallId: 'call-9', partialResult: 'x' },
      { type: 'compaction_start', reason: 'manual' },
      { type: 'queue_update' },
    ]) {
      expect(toCodeMuxEvents(event, ctx)).toEqual([]);
    }
  });
});
