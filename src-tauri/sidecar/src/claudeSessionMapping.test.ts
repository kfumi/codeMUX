import { describe, expect, it } from 'vitest';

import { shouldCaptureClaudeSessionMapping } from './claudeSessionMapping';

describe('shouldCaptureClaudeSessionMapping', () => {
  it('does not capture stale session ids from Claude execution error results', () => {
    expect(
      shouldCaptureClaudeSessionMapping({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'old-claude-session',
      }),
    ).toBe(false);
  });

  it('captures usable Claude session ids from non-error messages', () => {
    expect(
      shouldCaptureClaudeSessionMapping({
        type: 'system',
        subtype: 'init',
        session_id: 'new-claude-session',
      }),
    ).toBe(true);
  });
});
