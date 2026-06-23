import { describe, expect, it } from 'vitest';

import { shouldEmitDoneOnClaudeIteratorCompletion } from './claudeTurnCompletion.js';

describe('shouldEmitDoneOnClaudeIteratorCompletion', () => {
  it('finishes an active Claude turn when the SDK iterator ends without a result event', () => {
    expect(shouldEmitDoneOnClaudeIteratorCompletion({
      turnActive: true,
      sawResult: false,
      aborted: false,
    })).toBe(true);
  });

  it('does not emit a duplicate done after result or abort handling', () => {
    expect(shouldEmitDoneOnClaudeIteratorCompletion({
      turnActive: false,
      sawResult: true,
      aborted: false,
    })).toBe(false);

    expect(shouldEmitDoneOnClaudeIteratorCompletion({
      turnActive: true,
      sawResult: false,
      aborted: true,
    })).toBe(false);
  });
});
