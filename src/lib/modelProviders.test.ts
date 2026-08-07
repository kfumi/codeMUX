import { describe, expect, it } from 'vitest';

import {
  isProviderUsable,
  providerUnusableReason,
  requiredProtocol,
} from './modelProviders';
import type { ModelProvider } from '@/types/provider';

function deepseek(partial?: Partial<ModelProvider>): ModelProvider {
  return {
    id: 'deepseek-1',
    name: 'DeepSeek',
    enabled: true,
    api_key: 'sk-test',
    endpoints: [
      { protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic' },
      { protocol: 'openai_compatible', base_url: 'https://api.deepseek.com', codex_needs_proxy: true },
    ],
    models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
    default_model: 'deepseek-v4-flash',
    ...partial,
  };
}

describe('modelProviders helpers', () => {
  it('maps agent kinds to protocols', () => {
    expect(requiredProtocol('claude_code')).toBe('anthropic');
    expect(requiredProtocol('codex')).toBe('openai_compatible');
    expect(requiredProtocol('opencode')).toBe('openai_compatible');
    expect(requiredProtocol('gemini_cli')).toBeNull();
  });

  it('treats dual-endpoint deepseek as usable for claude and codex', () => {
    const provider = deepseek();
    expect(isProviderUsable(provider, 'claude_code')).toBe(true);
    expect(isProviderUsable(provider, 'codex')).toBe(true);
  });

  it('reports missing openai endpoint for codex', () => {
    const provider = deepseek({
      endpoints: [{ protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic' }],
    });
    expect(isProviderUsable(provider, 'codex')).toBe(false);
    expect(providerUnusableReason(provider, 'codex')).toContain('OpenAI');
  });
});
