import { describe, expect, it } from 'vitest';

import { isSteerBlockedPrompt, normalizeImmediateRunMode, queuedRunNowHint } from './agentSteer';

describe('agentSteer', () => {
  it('blocks slash commands from steering', () => {
    expect(isSteerBlockedPrompt('/compact')).toBe(true);
    expect(isSteerBlockedPrompt('  /status')).toBe(true);
    expect(isSteerBlockedPrompt('please /compact later')).toBe(false);
    expect(isSteerBlockedPrompt('focus on tests')).toBe(false);
  });

  it('defaults unknown immediate-run modes to steer', () => {
    expect(normalizeImmediateRunMode(undefined)).toBe('steer');
    expect(normalizeImmediateRunMode('steer')).toBe('steer');
    expect(normalizeImmediateRunMode('interrupt')).toBe('interrupt');
    expect(normalizeImmediateRunMode('queue')).toBe('steer');
  });

  it('uses inject copy for agents that can steer', () => {
    expect(queuedRunNowHint('pi')).toBe('注入当前轮并立即执行这条消息');
    expect(queuedRunNowHint('claude_code')).toBe('注入当前轮并立即执行这条消息');
    expect(queuedRunNowHint('codex')).toBe('注入当前轮并立即执行这条消息');
    expect(queuedRunNowHint('opencode')).toBe('注入当前轮并立即执行这条消息');
  });

  it('uses interrupt copy when steer is unavailable or the user prefers interrupt', () => {
    expect(queuedRunNowHint('gemini_cli')).toBe('打断当前任务并立即执行这条消息');
    expect(queuedRunNowHint(undefined)).toBe('打断当前任务并立即执行这条消息');
    expect(queuedRunNowHint('pi', 'interrupt')).toBe('打断当前任务并立即执行这条消息');
  });
});
