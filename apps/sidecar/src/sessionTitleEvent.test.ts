import { describe, expect, it } from 'vitest';
import {
  buildSessionTitleEvent,
  extractClaudeSessionTitle,
  isOpenCodePlaceholderTitle,
} from './sessionTitleEvent.js';

describe('buildSessionTitleEvent', () => {
  it('builds the wire envelope with runtime generation when provided', () => {
    expect(buildSessionTitleEvent({
      appSessionId: 'session-1',
      agentKind: 'opencode',
      title: 'Native title',
      runtimeGeneration: 3,
    })).toEqual({
      type: 'agent_session_title',
      app_session_id: 'session-1',
      agent_kind: 'opencode',
      title: 'Native title',
      runtime_generation: 3,
    });
  });

  it('omits runtime_generation when absent (claude/codex)', () => {
    expect(buildSessionTitleEvent({
      appSessionId: 'session-1',
      agentKind: 'claude_code',
      title: 'AI title',
    })).toEqual({
      type: 'agent_session_title',
      app_session_id: 'session-1',
      agent_kind: 'claude_code',
      title: 'AI title',
    });
  });
});

describe('isOpenCodePlaceholderTitle', () => {
  it('recognizes the new-session and child-session placeholders', () => {
    expect(isOpenCodePlaceholderTitle('New session - 2026-09-15T00:00:00.000Z')).toBe(true);
    expect(isOpenCodePlaceholderTitle('Child session - 2026-09-15T00:00:00.000Z')).toBe(true);
    expect(isOpenCodePlaceholderTitle('Refactor auth module')).toBe(false);
    expect(isOpenCodePlaceholderTitle('New session - advanced')).toBe(true);
  });
});

describe('extractClaudeSessionTitle', () => {
  it('returns the trimmed summary from SDKSessionInfo', () => {
    expect(extractClaudeSessionTitle({ summary: '  AI title  ' })).toBe('AI title');
  });

  it('returns undefined for missing session info or blank summaries', () => {
    expect(extractClaudeSessionTitle(undefined)).toBeUndefined();
    expect(extractClaudeSessionTitle(null)).toBeUndefined();
    expect(extractClaudeSessionTitle('nope')).toBeUndefined();
    expect(extractClaudeSessionTitle({ summary: '   ' })).toBeUndefined();
    expect(extractClaudeSessionTitle({ summary: 42 })).toBeUndefined();
  });
});
