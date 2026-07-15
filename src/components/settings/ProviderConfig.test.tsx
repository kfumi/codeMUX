// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { ProviderConfigPanel } from './ProviderConfig';

const upsertAgentProfile = vi.fn(() => Promise.resolve());

function createConfig() {
  return {
    providers: [], active_provider_id: null, agent_defaults: { default_agent_kind: 'claude_code' as const },
    agent_configs: { claude_code: { executable_mode: 'auto' as const, resume_sessions: true }, codex: { sdk_mode: 'responses' as const }, gemini_cli: {}, opencode: {} },
    theme: 'System' as const, compact_ai_output: false, default_open_target: 'file_explorer' as const,
    agent_profile_registry: {
      profiles: [{
        id: 'codex-profile', agent_kind: 'codex' as const, name: 'OpenRouter', note: '代理档案',
        models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }], default_model: 'gpt-5',
        native_config: { type: 'codex' as const, api_key: '', openai_base_url: 'https://openrouter.ai/api/v1', codex_needs_proxy: true },
      }],
      active_profile_ids: { codex: 'codex-profile' },
    },
  };
}

describe('ProviderConfigPanel', () => {
  beforeEach(() => {
    upsertAgentProfile.mockClear();
    useSettingsStore.setState((state) => ({
      ...state, config: createConfig(), upsertAgentProfile, activateAgentProfile: vi.fn(() => Promise.resolve()),
      deleteAgentProfile: vi.fn(() => Promise.resolve()), testAgentProfile: vi.fn(() => Promise.resolve()),
    }));
  });

  afterEach(() => cleanup());

  it('uses agent tabs and only displays profiles for the selected agent', () => {
    render(<ProviderConfigPanel />);
    expect(screen.queryByText('OpenRouter')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.getByText('OpenRouter')).toBeTruthy();
  });

  it('edits profile models as one model per line and sends the Codex native shape', async () => {
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const textarea = screen.getByLabelText(/模型列表/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('gpt-5\ngpt-5-mini');
    fireEvent.change(textarea, { target: { value: 'gpt-5\ngpt-5-mini\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(upsertAgentProfile).toHaveBeenCalled());
    expect(upsertAgentProfile).toHaveBeenCalledWith(expect.objectContaining({
      agent_kind: 'codex', default_model: 'gpt-5', models: [{ id: 'gpt-5', name: 'gpt-5' }, { id: 'gpt-5-mini', name: 'gpt-5-mini' }],
      native_config: expect.objectContaining({ type: 'codex', codex_needs_proxy: true }),
    }));
  });

  it('does not prefill a saved API key when editing a profile', () => {
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect((screen.getByPlaceholderText('输入新密钥以替换') as HTMLInputElement).value).toBe('');
  });

  it('marks migrated profiles that require a native configuration review', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: {
          ...state.config.agent_profile_registry!,
          profiles: state.config.agent_profile_registry!.profiles.map((profile) => ({
            ...profile,
            native_config: { ...profile.native_config, requires_review: true },
          })),
        },
      } : null,
    }));

    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));

    expect(screen.getByText('由旧供应商迁移而来，请核对高级原生配置。')).toBeTruthy();
  });
});
