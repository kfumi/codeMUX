import { describe, expect, it } from 'vitest';

import {
  mapToAnthropicEffort,
  mapToClaudeEffort,
  mapToCodexEffort,
  mapToOpenAIChatEffort,
  mapToResponsesEffort,
  normalizeReasoningEffort,
} from './reasoningEffort.js';

describe('normalizeReasoningEffort', () => {
  it('accepts the six canonical values', () => {
    expect(normalizeReasoningEffort('none')).toBe('none');
    expect(normalizeReasoningEffort('low')).toBe('low');
    expect(normalizeReasoningEffort('medium')).toBe('medium');
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('xhigh')).toBe('xhigh');
    expect(normalizeReasoningEffort('max')).toBe('max');
  });

  it('maps aliases and rejects unknown values', () => {
    expect(normalizeReasoningEffort('off')).toBe('none');
    expect(normalizeReasoningEffort('disabled')).toBe('none');
    expect(normalizeReasoningEffort('minimal')).toBe('low');
    expect(normalizeReasoningEffort('unknown')).toBeUndefined();
    expect(normalizeReasoningEffort(1)).toBeUndefined();
  });
});

describe('protocol mapping', () => {
  it('maps Responses API to none/low/high/max', () => {
    expect(mapToResponsesEffort('none')).toBe('none');
    expect(mapToResponsesEffort('low')).toBe('low');
    expect(mapToResponsesEffort('medium')).toBe('high');
    expect(mapToResponsesEffort('high')).toBe('high');
    expect(mapToResponsesEffort('xhigh')).toBe('max');
    expect(mapToResponsesEffort('max')).toBe('max');
  });

  it('maps OpenAI Chat Completions effort and disables thinking for none', () => {
    expect(mapToOpenAIChatEffort('none')).toBeNull();
    expect(mapToOpenAIChatEffort('low')).toBe('low');
    expect(mapToOpenAIChatEffort('medium')).toBe('high');
    expect(mapToOpenAIChatEffort('high')).toBe('high');
    expect(mapToOpenAIChatEffort('xhigh')).toBe('max');
    expect(mapToOpenAIChatEffort('max')).toBe('max');
  });

  it('maps Anthropic output_config.effort the same way as OpenAI Chat intensity', () => {
    expect(mapToAnthropicEffort('none')).toBeNull();
    expect(mapToAnthropicEffort('low')).toBe('low');
    expect(mapToAnthropicEffort('medium')).toBe('high');
    expect(mapToAnthropicEffort('max')).toBe('max');
  });

  it('keeps Codex catalog values including xhigh', () => {
    expect(mapToCodexEffort('none')).toBe('none');
    expect(mapToCodexEffort('medium')).toBe('medium');
    expect(mapToCodexEffort('xhigh')).toBe('xhigh');
    expect(mapToCodexEffort('max')).toBe('xhigh');
  });

  it('omits Claude SDK effort when thinking is off', () => {
    expect(mapToClaudeEffort('none')).toBeUndefined();
    expect(mapToClaudeEffort('medium')).toBe('medium');
    expect(mapToClaudeEffort('xhigh')).toBe('max');
    expect(mapToClaudeEffort('max')).toBe('max');
  });
});
