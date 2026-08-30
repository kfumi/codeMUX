import { describe, expect, it } from 'vitest';

import {
  codexEndpoint,
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
      { protocol: 'openai_compatible', base_url: 'https://api.deepseek.com', codex_needs_proxy: false },
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

  it('codex prefers the responses endpoint and falls back to chat', () => {
    const fallbackOnly = deepseek();
    expect(codexEndpoint(fallbackOnly)?.protocol).toBe('openai_compatible');

    const withResponses = deepseek({
      endpoints: [
        {
          protocol: 'openai_responses',
          base_url: 'https://open.bigmodel.cn/api/v1',
          codex_needs_proxy: false,
        },
        {
          protocol: 'openai_compatible',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          codex_needs_proxy: true,
        },
      ],
    });
    expect(codexEndpoint(withResponses)?.protocol).toBe('openai_responses');
    expect(isProviderUsable(withResponses, 'codex')).toBe(true);
    expect(isProviderUsable(withResponses, 'opencode')).toBe(true);
  });

  it('ignores responses endpoints with empty base_url', () => {
    const provider = deepseek({
      endpoints: [
        { protocol: 'openai_responses', base_url: '  ' },
        { protocol: 'openai_compatible', base_url: 'https://api.deepseek.com' },
      ],
    });
    expect(codexEndpoint(provider)?.protocol).toBe('openai_compatible');
  });

  it('treats a responses-only provider as usable for codex but not opencode', () => {
    const provider = deepseek({
      endpoints: [
        {
          protocol: 'openai_responses',
          base_url: 'https://open.bigmodel.cn/api/v1',
          codex_needs_proxy: false,
        },
      ],
    });
    expect(isProviderUsable(provider, 'codex')).toBe(true);
    expect(isProviderUsable(provider, 'opencode')).toBe(false);
    expect(providerUnusableReason(provider, 'opencode')).toBe('缺少 OpenAI 兼容端点');
  });
});
