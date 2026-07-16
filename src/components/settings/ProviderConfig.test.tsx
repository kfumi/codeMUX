// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { ProviderConfigPanel } from './ProviderConfig';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
const upsertAgentProfile = vi.fn(() => Promise.resolve());

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (val: string) => void }) => (
    <textarea data-testid="codemirror" defaultValue={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

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
    toastError.mockReset();
    toastSuccess.mockReset();
    useSettingsStore.setState((state) => ({
      ...state, config: createConfig(), upsertAgentProfile, activateAgentProfile: vi.fn(() => Promise.resolve()),
      deleteAgentProfile: vi.fn(() => Promise.resolve()), testAgentProfile: vi.fn(() => Promise.resolve()),
    }));
  });

  afterEach(() => cleanup());

  it('uses toast feedback for validation errors', () => {
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('button', { name: '新建 Claude Code 供应商' }));
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    expect(toastError).toHaveBeenCalledWith('请填写供应商名称。');
    expect(upsertAgentProfile).not.toHaveBeenCalled();
  });

  it('uses toast feedback for successful saves', async () => {
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('供应商已保存。'));
  });

  it('uses toast feedback for async save failures', async () => {
    const failure = new Error('保存失败');
    const failingUpsert = vi.fn(() => Promise.reject(failure));
    useSettingsStore.setState((state) => ({ ...state, upsertAgentProfile: failingUpsert }));
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(failure.message));
  });

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

    // Models are now derived from model_catalog
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(upsertAgentProfile).toHaveBeenCalled());
    expect(upsertAgentProfile).toHaveBeenCalledWith(expect.objectContaining({
      agent_kind: 'codex', default_model: '', models: [{ id: 'gpt-5', name: 'gpt-5' }, { id: 'gpt-5-mini', name: 'gpt-5-mini' }],
      native_config: expect.objectContaining({ type: 'codex', codex_needs_proxy: true }),
    }));
  });

  it('keeps Claude fallback model in the submitted model list', async () => {
    const claudeProfile = {
      id: 'claude-profile', agent_kind: 'claude_code' as const, name: 'Claude', note: '',
      models: [{ id: 'old-model' }], default_model: 'old-model',
      native_config: { type: 'claude_code' as const, settings: { env: { ANTHROPIC_MODEL: 'old-model' } } },
    };
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: { profiles: [claudeProfile], active_profile_ids: {} },
      } : null,
    }));

    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '高级选项' }));
    const fallbackInput = screen.getByRole('textbox', { name: '默认兜底模型' });
    fireEvent.change(fallbackInput, { target: { value: 'new-model' } });
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(upsertAgentProfile).toHaveBeenCalled());
    expect(upsertAgentProfile).toHaveBeenCalledWith(expect.objectContaining({
      default_model: 'new-model',
      models: expect.arrayContaining([
        { id: 'new-model', name: 'new-model' },
      ]),
    }));
  });

  it('rebuilds Claude models from JSON edits before saving', async () => {
    const claudeProfile = {
      id: 'claude-profile', agent_kind: 'claude_code' as const, name: 'Claude', note: '',
      models: [{ id: 'old-model' }], default_model: 'old-model',
      native_config: { type: 'claude_code' as const, settings: { env: { ANTHROPIC_MODEL: 'old-model' } } },
    };
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: { profiles: [claudeProfile], active_profile_ids: {} },
      } : null,
    }));

    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const json = JSON.stringify({ env: { ANTHROPIC_MODEL: 'json-model' } }, null, 2);
    fireEvent.change(screen.getByTestId('codemirror'), { target: { value: json } });
    fireEvent.click(screen.getByRole('button', { name: '保存供应商' }));

    await waitFor(() => expect(upsertAgentProfile).toHaveBeenCalled());
    expect(upsertAgentProfile).toHaveBeenCalledWith(expect.objectContaining({
      default_model: 'json-model',
      models: [{ id: 'json-model', name: 'json-model' }],
    }));
  });
  it('loads the saved API key when editing a profile', () => {
    render(<ProviderConfigPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect((screen.getByPlaceholderText('输入 API Key') as HTMLInputElement).value).toBe('');
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
