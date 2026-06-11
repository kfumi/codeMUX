// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
            default_provider_id: null,
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
      },
      setDefaultAgentKind: vi.fn(),
      updateAgentConfig: vi.fn().mockResolvedValue(undefined),
      getDefaultAgentKind: () => 'codex',
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows Codex provider controls when Codex is available', () => {
    render(<AgentSettingsPanel />);

    expect(screen.getByText('Codex Provider')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use Active Provider' })).toBeTruthy();
  });

  it('persists the selected Codex default provider', () => {
    const updateAgentConfig = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState((state) => ({
      ...state,
      updateAgentConfig,
    }));

    render(<AgentSettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Codex Provider' }));

    expect(updateAgentConfig).toHaveBeenCalledWith('codex', {
      default_provider_id: 'provider-codex',
    });
  });
});
