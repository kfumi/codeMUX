// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Provider } from '../../types/provider';
import { useSettingsStore } from '../../stores/settingsStore';
import { ProviderConfigPanel } from './ProviderConfig';

const provider: Provider = {
  id: 'provider-1',
  name: 'OpenRouter',
  api_key: 'key',
  anthropic_base_url: 'https://anthropic.example.com',
  openai_base_url: 'https://openrouter.ai/api/v1',
  default_model: 'claude-sonnet-4-20250514',
  models: ['claude-sonnet-4-20250514', 'claude-opus-4-1'],
};

describe('ProviderConfigPanel', () => {
  const updateProvider = vi.fn();
  const fetchModels = vi.fn();

  beforeEach(() => {
    updateProvider.mockResolvedValue(undefined);
    fetchModels.mockResolvedValue([
      { id: 'gpt-5', owned_by: 'openai' },
      { id: 'claude-opus-4-1', owned_by: 'anthropic' },
    ]);
    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [provider],
        active_provider_id: 'provider-1',
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
      },
      updateProvider,
      fetchModels,
      deleteProvider: vi.fn(),
      setActiveProvider: vi.fn(),
      testProvider: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('edits provider models as one model per line', async () => {
    render(<ProviderConfigPanel />);

    fireEvent.click(screen.getByText('OpenRouter'));

    const textarea = screen.getByLabelText('模型列表') as HTMLTextAreaElement;
    expect(textarea.value).toBe('claude-sonnet-4-20250514\nclaude-opus-4-1');

    fireEvent.change(textarea, {
      target: {
        value: 'gpt-5\nclaude-opus-4-1\n',
      },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(updateProvider).toHaveBeenCalled());
    expect(updateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        default_model: 'gpt-5',
        models: ['gpt-5', 'claude-opus-4-1'],
      }),
    );
  });

  it('fills fetched models into the model textarea one per line', async () => {
    render(<ProviderConfigPanel />);

    fireEvent.click(screen.getByText('OpenRouter'));
    fireEvent.click(screen.getByText('获取列表'));

    await waitFor(() => expect(fetchModels).toHaveBeenCalled());
    expect((screen.getByLabelText('模型列表') as HTMLTextAreaElement).value).toBe('gpt-5\nclaude-opus-4-1');
  });
  it('persists the Codex local route mapping toggle', async () => {
    render(<ProviderConfigPanel />);

    fireEvent.click(screen.getByText('OpenRouter'));
    fireEvent.click(screen.getByRole('checkbox', { name: '需要本地路由映射' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateProvider).toHaveBeenCalled());
    expect(updateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        codex_needs_proxy: false,
      }),
    );
  });
});
