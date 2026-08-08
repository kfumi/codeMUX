import { describe, expect, it } from 'vitest';

import {
  normalizeModelId,
  stripAggregatorPrefixes,
  stripBedrockRevision,
  stripVariantQuantDateSuffixes,
} from './normalize';

describe('normalizeModelId (Cherry-aligned)', () => {
  it('strips colon variants, aggregator prefixes, and dates', () => {
    expect(normalizeModelId('gpt-4o:free')).toBe('gpt-4o');
    expect(normalizeModelId('aihubmix-gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelId('qwen-plus-2025-12-01')).toBe('qwen-plus');
    expect(normalizeModelId('glm-4-5-fp8')).toBe('glm-4-5');
  });

  it('folds dotted versions and path segments', () => {
    expect(normalizeModelId('gpt-4.1')).toBe('gpt-4-1');
    expect(normalizeModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelId('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('strips Bedrock ARN vendor + revision', () => {
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-v1:0')).toBe('claude-sonnet-4-5');
    expect(stripBedrockRevision('claude-sonnet-4-5-v1:0')).toBe('claude-sonnet-4-5');
  });

  it('exposes variant remainder via stripVariantQuantDateSuffixes', () => {
    expect(stripVariantQuantDateSuffixes('gpt-4o:free')).toBe('gpt-4o');
    expect(stripVariantQuantDateSuffixes('gpt-4o-thinking')).toBe('gpt-4o');
    expect(stripAggregatorPrefixes('aihubmix-gpt-4o')).toBe('gpt-4o');
  });
});
