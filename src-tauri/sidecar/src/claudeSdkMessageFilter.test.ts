import { describe, expect, it } from 'vitest';

import { shouldForwardClaudeSdkMessage } from './claudeSdkMessageFilter.js';

describe('shouldForwardClaudeSdkMessage', () => {
  it('keeps transcript and stream messages', () => {
    expect(shouldForwardClaudeSdkMessage({ type: 'assistant' })).toBe(true);
    expect(shouldForwardClaudeSdkMessage({ type: 'user' })).toBe(true);
    expect(shouldForwardClaudeSdkMessage({ type: 'result' })).toBe(true);
    expect(shouldForwardClaudeSdkMessage({ type: 'stream_event' })).toBe(true);
    expect(shouldForwardClaudeSdkMessage({ type: 'system', subtype: 'compact_boundary' })).toBe(true);
  });

  it('drops high-frequency SDK progress messages that have no transcript consumer', () => {
    expect(shouldForwardClaudeSdkMessage({ type: 'tool_progress' })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({ type: 'system', subtype: 'thinking_tokens' })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({ type: 'system', subtype: 'task_progress' })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({ type: 'system', subtype: 'status' })).toBe(false);
  });

  it('drops sidechain and task notification messages before the transport boundary', () => {
    expect(shouldForwardClaudeSdkMessage({
      type: 'assistant',
      parent_tool_use_id: 'tool-parent',
    })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({
      type: 'user',
      isSidechain: true,
    })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({
      type: 'system',
      subtype: 'task_notification',
    })).toBe(false);
    expect(shouldForwardClaudeSdkMessage({
      type: 'user',
      origin: { kind: 'task-notification' },
    })).toBe(false);
  });
});
