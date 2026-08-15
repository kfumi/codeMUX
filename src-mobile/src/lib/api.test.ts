import { describe, expect, it } from 'vitest';

import { providerSupportsAgent, resolveDefaultProvider, type MobileBootstrap } from './api';

const bootstrap: MobileBootstrap = {
  defaultAgentKind: 'claude_code',
  activeProviderId: 'provider-2',
  providers: [
    {
      id: 'provider-1',
      name: 'Anthropic',
      enabled: true,
      configured: true,
      defaultModel: 'sonnet',
      models: [{ id: 'sonnet' }],
      protocols: ['anthropic'],
    },
    {
      id: 'provider-2',
      name: 'OpenAI',
      enabled: true,
      configured: true,
      defaultModel: 'gpt-5',
      models: [{ id: 'gpt-5' }],
      protocols: ['openai_compatible'],
    },
  ],
  agentDefaults: {
    claude_code: { providerId: 'provider-1', model: 'sonnet' },
    codex: { providerId: 'provider-2', model: 'gpt-5' },
    opencode: { providerId: null, model: null },
  },
  reasoningEfforts: ['high'],
  permissionPresets: {
    claude_code: { permissionMode: 'default' },
    codex: { sandboxMode: 'danger-full-access' },
    opencode: { permissionMode: 'full_access' },
  },
};

describe('providerSupportsAgent', () => {
  it('matches protocol to agent kind', () => {
    expect(providerSupportsAgent(bootstrap.providers[0], 'claude_code')).toBe(true);
    expect(providerSupportsAgent(bootstrap.providers[0], 'codex')).toBe(false);
  });
});

describe('resolveDefaultProvider', () => {
  it('prefers agent-specific default provider', () => {
    expect(resolveDefaultProvider(bootstrap, 'claude_code')?.id).toBe('provider-1');
    expect(resolveDefaultProvider(bootstrap, 'codex')?.id).toBe('provider-2');
  });
});
