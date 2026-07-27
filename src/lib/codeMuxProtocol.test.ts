import { describe, expect, it } from 'vitest';
import { toLegacyStreamingMessage } from './codeMuxProtocol';

describe('CodeMUX frontend protocol adapter', () => {
  it('keeps domain deltas compatible with the internal streaming model', () => {
    expect(toLegacyStreamingMessage({
      type: 'text_delta',
      session_id: 'session-1',
      index: 1,
      text: 'hello',
    })).toEqual({
      kind: 'streaming',
      data: {
        session_id: 'session-1',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'hello' },
        },
      },
    });
  });
});
