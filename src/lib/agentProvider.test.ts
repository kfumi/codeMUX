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
      models: ['claude-sonnet-4-20250514', 'claude-opus-4-1'],
    },
    {
      id: 'codex-provider',
      name: 'Codex Provider',
      api_key: 'openai-key',
      anthropic_base_url: 'https://anthropic-proxy.internal',
      openai_base_url: 'https://api.openai.com/v1',
      default_model: 'o4-mini',
      models: ['o4-mini', 'gpt-5'],
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
  compact_ai_output: false,
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
      model: 'o4-mini',
      runtimeModel: 'o4-mini[1m]',
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
      runtimeModel: 'o4-mini',
      codexNeedsProxy: false,
    });
  });

  it('lets provider config force Codex direct mode for a non-OpenAI endpoint', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'codex',
        config: {
          ...config,
          providers: [
            {
              ...config.providers[0],
              codex_needs_proxy: false,
            },
          ],
          active_provider_id: 'claude-provider',
        },
      }),
    ).toMatchObject({
      provider: expect.objectContaining({ id: 'claude-provider' }),
      baseUrl: 'https://openrouter.ai/api',
      codexNeedsProxy: false,
    });
  });

  it('defaults legacy non-OpenAI Codex providers to proxy mode', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'codex',
        config,
        sessionProviderId: 'claude-provider',
      }),
    ).toMatchObject({
      codexNeedsProxy: true,
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
      runtimeModel: 'claude-sonnet-4-20250514',
    });
  });

  it('lets the selected session model override the provider default model', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'codex',
        config,
        sessionModel: 'gpt-5',
      }),
    ).toMatchObject({
      provider: expect.objectContaining({ id: 'codex-provider' }),
      model: 'gpt-5',
      runtimeModel: 'gpt-5',
    });
  });

  it('keeps the selected session model display-safe while applying the Claude 1M suffix only at runtime', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'claude_code',
        config,
        sessionModel: 'claude-opus-4-1',
      }),
    ).toMatchObject({
      model: 'claude-opus-4-1',
      runtimeModel: 'claude-opus-4-1[1m]',
    });
  });

  it('normalizes legacy Claude 1M session model names for display without duplicating the runtime suffix', () => {
    expect(
      resolveAgentProviderConfig({
        agentKind: 'claude_code',
        config,
        sessionModel: 'claude-opus-4-1[1m]',
      }),
    ).toMatchObject({
      model: 'claude-opus-4-1',
      runtimeModel: 'claude-opus-4-1[1m]',
    });
  });
});
