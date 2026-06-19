// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSettingsPanel } from './AgentSettings';
import { useSettingsStore } from '../../stores/settingsStore';

describe('AgentSettingsPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [
          {
            id: 'provider-active',
            name: 'Active Provider',
            api_key: 'key-1',
            anthropic_base_url: 'https://api.anthropic.com',
            openai_base_url: 'https://api.openai.com',
            default_model: 'claude-sonnet-4-20250514',
          },
          {
            id: 'provider-codex',
            name: 'Codex Provider',
            api_key: 'key-2',
            anthropic_base_url: 'https://proxy.example.com/anthropic',
            openai_base_url: 'https://proxy.example.com/v1/chat/completions',
            default_model: 'o4-mini',
          },
        ],
        active_provider_id: 'provider-active',
        agent_defaults: {
          default_agent_kind: 'codex',
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
      },
      setDefaultAgentKind: vi.fn(),
      getDefaultAgentKind: () => 'codex',
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('does not show duplicate codex provider controls', () => {
    render(<AgentSettingsPanel />);

    expect(screen.queryByText('Codex Default Provider')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use Active Provider' })).toBeNull();
  });

  it('keeps the local proxy controls visible when the active provider does not need proxy routing', () => {
    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            providers: state.config.providers.map((provider) =>
              provider.id === 'provider-active'
                ? { ...provider, codex_needs_proxy: false }
                : provider,
            ),
          }
        : null,
      proxyRunning: false,
      proxyUrl: null,
    }));

    render(<AgentSettingsPanel />);

    expect(screen.getByText('本地代理路由')).toBeTruthy();
    expect(screen.getByRole('button', { name: '不需要' })).toHaveProperty('disabled', true);
  });
});
