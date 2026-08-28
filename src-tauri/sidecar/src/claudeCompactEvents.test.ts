import { describe, expect, it } from 'vitest';

import {
  buildClaudeCompactBoundaryEvent,
  isManualCompactPrompt,
  normalizeClaudeCompactBoundaryMessage,
  readClaudeCompactPreTokens,
} from './claudeCompactEvents.js';

describe('claudeCompactEvents', () => {
  it('detects manual /compact prompts without attachments', () => {
    expect(isManualCompactPrompt('/compact')).toBe(true);
    expect(isManualCompactPrompt('/compact', { text: '/compact' })).toBe(true);
    expect(isManualCompactPrompt('/compact extra')).toBe(false);
    expect(isManualCompactPrompt('/compact', { text: '/compact', images: [{ name: 'a.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }] })).toBe(false);
  });

  it('builds compacting and completed boundary events', () => {
    expect(buildClaudeCompactBoundaryEvent('session-1', 'compacting', { trigger: 'manual' })).toMatchObject({
      type: 'system_event',
      subtype: 'compact_boundary',
      session_id: 'session-1',
      compact_metadata: { trigger: 'manual', status: 'compacting', pre_tokens: 0 },
    });
    expect(buildClaudeCompactBoundaryEvent('session-1', 'completed', { trigger: 'auto', pre_tokens: 1200, post_tokens: 300 })).toMatchObject({
      compact_metadata: { trigger: 'auto', status: 'completed', pre_tokens: 1200, post_tokens: 300 },
    });
  });

  it('reads pre-token hints from compacting status messages', () => {
    expect(readClaudeCompactPreTokens({ pre_tokens: 42 })).toBe(42);
    expect(readClaudeCompactPreTokens({ tokens: 99 })).toBe(99);
    expect(readClaudeCompactPreTokens({})).toBeUndefined();
  });

  it('normalizes Claude compact boundary SDK messages to completed system events', () => {
    expect(normalizeClaudeCompactBoundaryMessage({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-1',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 154311,
        postTokens: 14168,
      },
    }, 'session-1')).toMatchObject({
      type: 'system_event',
      event_id: 'compact-1',
      session_id: 'session-1',
      compact_metadata: {
        trigger: 'manual',
        status: 'completed',
        pre_tokens: 154311,
        post_tokens: 14168,
      },
    });
  });
});
