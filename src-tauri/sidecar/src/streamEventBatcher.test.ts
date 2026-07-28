import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushStreamEvents, emit, resetStreamEventSequences } from './streamEventBatcher.js';

describe('stream event transport batching', () => {
  afterEach(() => {
    flushStreamEvents();
    resetStreamEventSequences();
    vi.restoreAllMocks();
  });

  it('batches consecutive CodeMUX deltas without serializing legacy projections', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    emit({ type: 'text_delta', session_id: 'session-1', index: 0, text: 'a', event_id: 'event-1' });
    emit({ type: 'text_delta', session_id: 'session-1', index: 0, text: 'b', event_id: 'event-2' });
    flushStreamEvents();

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      type: 'codemux_event_batch',
      session_id: 'session-1',
      events: [
        { type: 'text_delta', session_id: 'session-1', index: 0, text: 'a', event_id: 'event-1', sequence: expect.any(Number) },
        { type: 'text_delta', session_id: 'session-1', index: 0, text: 'b', event_id: 'event-2', sequence: expect.any(Number) },
      ],
    });
  });

  it('converts supported legacy deltas and diagnoses unsupported provider deltas', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    emit({
      type: 'stream_event',
      session_id: 'session-1',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    emit({
      type: 'stream_event',
      session_id: 'session-1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    });
    emit({
      type: 'stream_event',
      session_id: 'session-1',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
    });
    flushStreamEvents();

    expect(writes.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'content_started',
        session_id: 'session-1',
        index: 0,
        content_kind: 'text',
        event_id: expect.any(String),
        sequence: expect.any(Number),
      },
      {
        type: 'codemux_event_batch',
        session_id: 'session-1',
        events: [
          { type: 'text_delta', session_id: 'session-1', index: 0, text: 'hello', event_id: expect.any(String), sequence: expect.any(Number) },
        ],
      },
      {
        type: 'diagnostic',
        subtype: 'unsupported_stream_event',
        session_id: 'session-1',
        event_id: expect.any(String),
        sequence: expect.any(Number),
      },
    ]);
  });

  it('assigns a monotonic envelope to non-batched CodeMUX events', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    emit({ type: 'assistant_message', session_id: 'envelope-session', content: [{ type: 'text', text: 'ok' }] });
    emit({ type: 'diagnostic', session_id: 'envelope-session', subtype: 'gap_detected' });

    const events = writes.map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'assistant_message', event_id: expect.any(String), sequence: expect.any(Number) });
    expect(events[1]).toMatchObject({ type: 'diagnostic', event_id: expect.any(String), sequence: expect.any(Number) });
    expect(events[1].sequence).toBe(events[0].sequence + 1);
  });
});
