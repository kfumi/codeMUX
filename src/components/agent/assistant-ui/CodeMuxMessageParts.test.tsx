import { describe, expect, it } from 'vitest';

import { getStreamStatusDisplay } from './CodeMuxMessageParts';

describe('getStreamStatusDisplay', () => {
  it('renders Codex mode-blocked diagnostics without labeling them as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'Codex collaboration mode blocked item/tool/requestUserInput: request_user_input_blocked_in_default_mode.',
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/requestUserInput',
        effective_mode: 'code',
        reason_code: 'request_user_input_blocked_in_default_mode',
        reason: 'requestUserInput is blocked while effective_mode=code',
        suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
        request_id: 'tool-1',
      },
    });

    expect(display.tone).toBe('warning');
    expect(display.text).toContain('协作模式已阻止');
    expect(display.text).toContain('request_user_input_blocked_in_default_mode');
    expect(display.text).not.toContain('连接断开');
  });

  it('keeps non-reconnecting stream failures labeled as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'stream closed before response.completed',
      is_reconnecting: false,
    });

    expect(display.tone).toBe('error');
    expect(display.text).toBe('连接断开: stream closed before response.completed');
  });
});
