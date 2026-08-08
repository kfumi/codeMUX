import { describe, expect, it } from 'vitest';

import type { Provider } from '../types/provider';
import {
  formatModelDisplayName,
  getPrimaryProviderModel,
  getProviderModelList,
  modelsFromText,
  modelsToText,
  normalizeProviderModels,
  resolveModelDisplayName,
} from './providerModels';

const baseProvider: Provider = {
  id: 'provider-1',
  name: 'Provider',
  api_key: 'key',
  anthropic_base_url: 'https://api.anthropic.com',
  openai_base_url: 'https://api.openai.com/v1',
  default_model: 'claude-sonnet-4-20250514',
};

describe('provider model helpers', () => {
  it('prettifies unmatched model ids', () => {
    expect(formatModelDisplayName('deepseek-v4-flash')).toBe('Deepseek V4 Flash');
    expect(formatModelDisplayName('custom-model')).toBe('Custom Model');
    expect(formatModelDisplayName('openai/gpt-5-preview')).toBe('Openai: GPT 5 Preview');
    expect(formatModelDisplayName('glm-5.2')).toBe('GLM 5.2');
  });

  it('uses registry curated names when resolving with or without provider context', () => {
    expect(resolveModelDisplayName({ id: 'gpt-4o' })).toBe('GPT-4o');
    expect(
      resolveModelDisplayName({
        id: 'deepseek-ai/DeepSeek-V3',
        providerTemplateId: 'siliconflow',
      }),
    ).toBe('DeepSeek V3 0324');
    expect(
      resolveModelDisplayName({ id: 'custom-model', name: 'Provider Display Name' }),
    ).toBe('Provider Display Name');
  });

  it('uses models in order and keeps the first model as the default model', () => {
    const provider = normalizeProviderModels({
      ...baseProvider,
      default_model: 'old-default',
      models: ['claude-opus-4-1', 'claude-sonnet-4-5'],
    });

    expect(provider.default_model).toBe('claude-opus-4-1');
    expect(getPrimaryProviderModel(provider)).toBe('claude-opus-4-1');
    expect(getProviderModelList(provider)).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
  });

  it('falls back to default_model for old provider configs without a models list', () => {
    expect(getProviderModelList(baseProvider)).toEqual(['claude-sonnet-4-20250514']);
    expect(getPrimaryProviderModel(baseProvider)).toBe('claude-sonnet-4-20250514');
  });

  it('parses one model per line and removes blank lines and duplicates', () => {
    expect(modelsFromText('  claude-opus-4-1\n\nclaude-sonnet-4-5\nclaude-opus-4-1  ')).toEqual([
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ]);
  });

  it('formats models as one model per line', () => {
    expect(modelsToText(['claude-opus-4-1', 'claude-sonnet-4-5'])).toBe(
      'claude-opus-4-1\nclaude-sonnet-4-5',
    );
  });

  it('uses the configured default model as the OpenCode-compatible fallback', () => {
    expect(getProviderModelList({ ...baseProvider, models: [], default_model: 'openai/gpt-5' })).toEqual([
      'openai/gpt-5',
    ]);
  });
});
