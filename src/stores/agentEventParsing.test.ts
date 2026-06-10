import { describe, expect, it } from 'vitest';

import {
  INTERRUPT_MARKER,
  isInterruptMarker,
  mapPersistedClaudeMessage,
  parseSdkUserMessage,
  shouldSuppressLiveEventWhileStopped,
} from './agentEventParsing';

describe('interrupt marker detection', () => {
  it('only matches the canonical interrupt marker', () => {
    expect(isInterruptMarker(INTERRUPT_MARKER)).toBe(true);
    expect(isInterruptMarker(' [Request interrupted by user] ')).toBe(true);
    expect(isInterruptMarker('request interrupted by user')).toBe(false);
  });
});

describe('parseSdkUserMessage', () => {
  it('keeps plain user text as a user event', () => {
    expect(
      parseSdkUserMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'stop here',
            },
          ],
        },
        parent_tool_use_id: null,
      }),
    ).toEqual({
      kind: 'user',
      data: { content: 'stop here' },
    });
  });

  it('keeps tool results as tool_result events', () => {
    const event = parseSdkUserMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'done',
          },
        ],
      },
      parent_tool_use_id: null,
    });

    expect(event.kind).toBe('tool_result');
  });
});

describe('mapPersistedClaudeMessage', () => {
  it('loads result messages from Claude JSONL history', () => {
    expect(
      mapPersistedClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: 'session-1',
        duration_ms: 10,
        duration_api_ms: 9,
        num_turns: 1,
        result: 'ok',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
        terminal_reason: 'completed',
      }),
    ).toEqual({
      kind: 'result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: 'session-1',
        duration_ms: 10,
        duration_api_ms: 9,
        num_turns: 1,
        result: 'ok',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
        terminal_reason: 'completed',
      },
    });
  });
});

describe('shouldSuppressLiveEventWhileStopped', () => {
  it('suppresses visible post-stop events but still allows terminal bookkeeping events', () => {
    expect(shouldSuppressLiveEventWhileStopped('assistant')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('user')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('tool_result')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('result')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('done')).toBe(false);
    expect(shouldSuppressLiveEventWhileStopped('error')).toBe(false);
  });
});
