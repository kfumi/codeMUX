import { describe, expect, it } from 'vitest';
import { applyReasoningOptions, isResponsesReasoningEnabled } from './codexReasoning.js';

describe('isResponsesReasoningEnabled', () => {
  it('defaults to enabled when reasoning is omitted', () => {
    expect(isResponsesReasoningEnabled({})).toBe(true);
  });

  it('turns off only for none', () => {
    expect(isResponsesReasoningEnabled({ reasoning: { effort: 'none' } })).toBe(false);
    expect(isResponsesReasoningEnabled({ reasoning: { effort: 'high' } })).toBe(true);
  });
});

describe('applyReasoningOptions', () => {
  it('maps Responses effort onto Chat Completions reasoning_effort for any model', () => {
    const chatBody: Record<string, unknown> = {};
    applyReasoningOptions(chatBody, { reasoning: { effort: 'high' } }, 'deepseek-chat');
    expect(chatBody.reasoning_effort).toBe('high');
    expect(chatBody.thinking).toBeUndefined();
  });

  it('maps medium to high and xhigh to max', () => {
    const medium: Record<string, unknown> = {};
    applyReasoningOptions(medium, { reasoning: { effort: 'medium' } }, 'some-model');
    expect(medium.reasoning_effort).toBe('high');

    const xhigh: Record<string, unknown> = {};
    applyReasoningOptions(xhigh, { reasoning: { effort: 'xhigh' } }, 'some-model');
    expect(xhigh.reasoning_effort).toBe('max');
  });

  it('omits reasoning_effort when thinking is disabled', () => {
    const chatBody: Record<string, unknown> = {};
    applyReasoningOptions(chatBody, { reasoning: { effort: 'none' } }, 'o4-mini');
    expect(chatBody.reasoning_effort).toBeUndefined();
    expect(chatBody.thinking).toBeUndefined();
  });

  it('injects thinking for GPT-5 Chat Completions', () => {
    const enabled: Record<string, unknown> = {};
    applyReasoningOptions(enabled, { reasoning: { effort: 'medium' } }, 'gpt-5.2');
    expect(enabled.thinking).toEqual({ type: 'enabled' });
    expect(enabled.reasoning_effort).toBe('high');

    const disabled: Record<string, unknown> = {};
    applyReasoningOptions(disabled, { reasoning: { effort: 'none' } }, 'gpt-5.2');
    expect(disabled.thinking).toEqual({ type: 'disabled' });
    expect(disabled.reasoning_effort).toBeUndefined();
  });

  it('does nothing when reasoning is omitted', () => {
    const chatBody: Record<string, unknown> = {};
    applyReasoningOptions(chatBody, {}, 'gpt-4o');
    expect(Object.keys(chatBody)).toHaveLength(0);
  });
});
