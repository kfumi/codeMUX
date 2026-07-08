// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from './StatusBar';
import { useSettingsStore } from '../../stores/settingsStore';

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('StatusBar', () => {
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
            openai_base_url: 'https://api.openai.com/v1',
            default_model: 'gpt-5',
            codex_needs_proxy: false,
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
        compact_ai_output: false,
        default_open_target: 'file_explorer',
      },
      proxyRunning: false,
      proxyUrl: null,
      proxyToggling: false,
      startProxy: vi.fn(),
      stopProxy: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps proxy status visible when the active provider does not need proxy routing', () => {
    render(<StatusBar />);

    expect(screen.getByRole('button', { name: /Proxy/ })).toBeTruthy();
  });
});
