import { describe, expect, it } from 'vitest';
import { toCodeMuxStreamEvent } from './codeMuxProtocol.js';

describe('CodeMUX stream protocol', () => {
  it('maps provider stream blocks to domain events', () => {
    expect(toCodeMuxStreamEvent('session-1', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'thinking_delta', thinking: 'reasoning' },
    }, () => 'event-1')).toMatchObject({
      type: 'reasoning_delta',
      session_id: 'session-1',
      index: 2,
      text: 'reasoning',
      event_id: 'event-1',
    });
  });

  it('does not serialize the transitional legacy projection', () => {
    const event = toCodeMuxStreamEvent('session-1', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }, () => 'event-1');

    expect(event).toHaveProperty('event');
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      type: 'content_started',
      session_id: 'session-1',
      index: 0,
      content_kind: 'text',
      event_id: 'event-1',
    });
  });

  it('maps tool input JSON deltas without treating them as unsupported events', () => {
    expect(toCodeMuxStreamEvent('session-1', {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{"command":' },
    }, () => 'event-tool-input')).toMatchObject({
      type: 'tool_input_delta',
      session_id: 'session-1',
      index: 3,
      partial_json: '{"command":',
      event_id: 'event-tool-input',
    });
  });
});
