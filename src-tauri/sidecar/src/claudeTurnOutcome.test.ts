import { describe, expect, it } from 'vitest';

import { toClaudeTurnOutcome } from './claudeTurnOutcome.js';

describe('toClaudeTurnOutcome', () => {
  it('maps a successful Claude result and usage into the CodeMUX outcome', () => {
    expect(toClaudeTurnOutcome({
      subtype: 'success',
      result: 'ok',
      is_error: false,
      duration_ms: 125,
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        reasoning_output_tokens: 2,
      },
    })).toEqual({
      outcome: 'completed',
      durationMs: 125,
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
      },
    });
  });

  it('maps provider errors and ignores malformed optional fields', () => {
    expect(toClaudeTurnOutcome({
      subtype: 'error_during_execution',
      result: 'tool failed',
      is_error: true,
      duration_ms: Number.NaN,
      usage: { input_tokens: '10' },
    })).toEqual({
      outcome: 'failed',
      reason: 'tool failed',
    });
  });
});
