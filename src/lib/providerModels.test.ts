import { describe, expect, it } from 'vitest';

import type { Provider } from '../types/provider';
import {
  getPrimaryProviderModel,
  getProviderModelList,
  modelsFromText,
  modelsToText,
  normalizeProviderModels,
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
