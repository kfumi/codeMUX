import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../types/provider';
import { resolveAgentProviderConfig } from './agentProvider';

const config: AppConfig = {
  providers: [
    {
      id: 'claude-provider',
      name: 'Claude Provider',
      api_key: 'anthropic-key',
      anthropic_base_url: 'https://api.anthropic.com',
      openai_base_url: 'https://openrouter.ai/api/v1',
      default_model: 'claude-sonnet-4-20250514',
    },
    {
      id: 'codex-provider',
      name: 'Codex Provider',
      api_key: 'openai-key',
      anthropic_base_url: 'https://anthropic-proxy.internal',
      openai_base_url: 'https://api.openai.com/v1',
      default_model: 'o4-mini',
      context_1m: true,
    },
  ],
  active_provider_id: 'codex-provider',
  agent_defaults: {
    default_agent_kind: 'claude_code',
  },
  agent_configs: {
    claude_code: {
      executable_mode: 'auto',
      resume_sessions: true,
    },
    codex: {
      sdk_mode: 'responses',
    },
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
};

describe('resolveAgentProviderConfig', () => {
  it('uses the active provider anthropic endpoint for Claude sessions', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'claude_code',
        config,
      }),
    ).toMatchObject({
      provider: expect.objectContaining({ id: 'codex-provider' }),
      apiKey: 'openai-key',
      baseUrl: 'https://anthropic-proxy.internal',
      model: 'o4-mini[1m]',
    });
  });

  it('uses the active provider openai endpoint for Codex sessions without [1m] suffix', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'codex',
        config,
      }),
    ).toMatchObject({
      provider: expect.objectContaining({ id: 'codex-provider' }),
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com',
      model: 'o4-mini',
    });
  });

  it('lets a bound session provider override the active provider', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'codex',
        config,
        sessionProviderId: 'claude-provider',
      }),
    ).toMatchObject({
      provider: expect.objectContaining({ id: 'claude-provider' }),
      baseUrl: 'https://openrouter.ai/api',
      model: 'claude-sonnet-4-20250514',
    });
  });
});
