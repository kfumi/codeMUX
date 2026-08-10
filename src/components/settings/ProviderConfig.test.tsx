// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const {
  fetchConfig,
  listTemplates,
  upsertModelProvider,
  fetchProviderModels,
  openExternal,
  settingsState,
} = vi.hoisted(() => ({
  fetchConfig: vi.fn(() => Promise.resolve()),
  listTemplates: vi.fn(() =>
    Promise.resolve([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        endpoints: [
          {
            protocol: 'anthropic',
            base_url: 'https://api.deepseek.com/anthropic',
            api_key_override: null,
            codex_needs_proxy: null,
          },
          {
            protocol: 'openai_compatible',
            base_url: 'https://api.deepseek.com',
            api_key_override: null,
            codex_needs_proxy: false,
          },
        ],
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
        default_model: 'deepseek-v4-flash',
        opencode_provider_key: 'deepseek',
        opencode_npm: '@ai-sdk/openai-compatible',
        default_codex_needs_proxy: false,
      },
      {
        id: 'zhipu',
        name: '智谱',
        endpoints: [
          {
            protocol: 'openai_compatible',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key_override: null,
            codex_needs_proxy: true,
          },
        ],
        models: [{ id: 'glm-4.7', name: 'GLM-4.7' }],
        default_model: 'glm-4.7',
        opencode_provider_key: 'zhipu',
        opencode_npm: '@ai-sdk/openai-compatible',
        default_codex_needs_proxy: true,
      },
    ]),
  ),
  upsertModelProvider: vi.fn(() => Promise.resolve()),
  fetchProviderModels: vi.fn(() =>
    Promise.resolve([
      { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
      { id: 'deepseek-new', owned_by: 'deepseek' },
    ]),
  ),
  openExternal: vi.fn(() => Promise.resolve()),
  settingsState: {
    config: {
      model_providers: [] as Array<Record<string, unknown>>,
      active_provider_id: null as string | null,
    },
  },
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: openExternal,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => ({
    config: settingsState.config,
    fetchConfig,
    upsertModelProvider,
    deleteModelProvider: vi.fn(),
    setActiveProvider: vi.fn(),
    setModelProviderEnabled: vi.fn(),
    instantiateBuiltinTemplate: vi.fn(),
    testModelProvider: vi.fn(),
  }),
}));

vi.mock('@/lib/tauri', () => ({
  configApi: {
    listBuiltinProviderTemplates: listTemplates,
    fetchProviderModels,
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ProviderConfigPanel, resolveProviderApiKeyUrl } from './ProviderConfig';

describe('ProviderConfigPanel', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    fetchConfig.mockClear();
    listTemplates.mockClear();
    upsertModelProvider.mockClear();
    fetchProviderModels.mockClear();
    openExternal.mockClear();
    settingsState.config = {
      model_providers: [],
      active_provider_id: null,
    };
  });

  it('lists builtin providers with logos and keeps add button under the list', async () => {
    const { container } = render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索模型平台...')).toBeTruthy();
    });

    const list = container.querySelector('.overflow-y-auto.px-2');
    expect(list).toBeTruthy();
    const listEl = list as HTMLElement;
    expect(within(listEl).getByText('深度求索')).toBeTruthy();
    expect(within(listEl).getByText('智谱')).toBeTruthy();
    expect(within(listEl).getByText('添加服务商')).toBeTruthy();
    expect(listEl.querySelectorAll('svg').length).toBeGreaterThan(0);

    fireEvent.click(within(listEl).getByText('添加服务商'));
    expect(await screen.findByText('添加自定义供应商')).toBeTruthy();
  });

  it('shows an official API key link for builtin providers', async () => {
    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://api.deepseek.com/anthropic')).toBeTruthy();
    });

    expect(resolveProviderApiKeyUrl('deepseek')).toBe('https://platform.deepseek.com/api_keys');
    const apiKeyButton = screen.getByRole('button', { name: /获取密钥/ });
    expect(apiKeyButton).toBeTruthy();
    fireEvent.click(apiKeyButton);
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledWith('https://platform.deepseek.com/api_keys');
    expect(resolveProviderApiKeyUrl('opencode-go')).toBe('https://opencode.ai/auth');
    expect(resolveProviderApiKeyUrl('moonshot')).toBe('https://platform.kimi.com/console/api-keys');
    expect(resolveProviderApiKeyUrl('mimo')).toBe('https://mimo.mi.com/');
    expect(resolveProviderApiKeyUrl('custom')).toBeNull();
  });

  it('starts with empty models, no default column, and toggles codex proxy switch', async () => {
    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://api.deepseek.com/anthropic')).toBeTruthy();
    });

    expect(screen.queryByText('设为当前供应商')).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getByText('模型 ID')).toBeTruthy();
    expect(within(table).queryByText('默认')).toBeNull();
    expect(within(table).getByText(/暂无模型/)).toBeTruthy();
    expect(screen.queryByDisplayValue('deepseek-v4-flash')).toBeNull();

    const switches = screen.getAllByRole('switch');
    const proxySwitch = switches[switches.length - 1];
    expect(proxySwitch.getAttribute('data-state')).toBe('unchecked');
    fireEvent.click(proxySwitch);
    await waitFor(() => {
      expect(proxySwitch.getAttribute('data-state')).toBe('checked');
    });

    expect(screen.queryByText(/Claude Code：/)).toBeNull();
    expect(screen.getByLabelText('显示密钥')).toBeTruthy();
  });

  it('fills default OpenAI model limits when adding a model', async () => {
    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://api.deepseek.com')).toBeTruthy();
    });

    const listEl = document.querySelector('.overflow-y-auto.px-2') as HTMLElement;
    fireEvent.click(within(listEl).getByText('深度求索'));
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));

    const modelIdInput = screen.getByPlaceholderText('model-id');
    fireEvent.change(modelIdInput, { target: { value: 'new-model' } });
    fireEvent.click(screen.getByRole('button', { name: '设置模型 new-model' }));

    expect(screen.getByDisplayValue('200000')).toBeTruthy();
    expect(screen.getByDisplayValue('128000')).toBeTruthy();
    expect(screen.getByDisplayValue('65536')).toBeTruthy();
  });

  it('opens model picker with api results', async () => {
    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /获取模型列表/ })).toBeTruthy();
    });

    const keyInput = screen.getByPlaceholderText('保存可留空，启用时必填');
    fireEvent.change(keyInput, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));

    expect(await screen.findByText(/深度求索 模型/)).toBeTruthy();
    await waitFor(() => {
      expect(fetchProviderModels).toHaveBeenCalledWith('sk-test', 'https://api.deepseek.com');
      expect(screen.getByText('deepseek-new')).toBeTruthy();
      expect(screen.getByText('来自接口')).toBeTruthy();
    });
  });

  it('allows renaming custom providers but not builtins', async () => {
    settingsState.config = {
      model_providers: [
        {
          id: 'ds-1',
          name: 'DeepSeek',
          enabled: false,
          api_key: '',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://api.deepseek.com',
              api_key_override: null,
              codex_needs_proxy: false,
            },
          ],
          models: [],
          default_model: '',
          builtin_template_id: 'deepseek',
          opencode_provider_key: 'deepseek',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
        {
          id: 'custom-1',
          name: '测试1',
          enabled: false,
          api_key: 'sk-test',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://example.com',
              api_key_override: null,
              codex_needs_proxy: true,
            },
          ],
          models: [],
          default_model: '',
          builtin_template_id: null,
          opencode_provider_key: 'codemux-openai',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
      ],
      active_provider_id: null,
    };

    const { container } = render(<ProviderConfigPanel />);
    const listEl = container.querySelector('.overflow-y-auto.px-2') as HTMLElement;

    await waitFor(() => {
      expect(within(listEl).getByText('深度求索')).toBeTruthy();
    });

    fireEvent.click(within(listEl).getByText('深度求索'));
    await waitFor(() => {
      expect(screen.queryByLabelText('编辑名称')).toBeNull();
    });

    fireEvent.click(within(listEl).getByText('测试1'));
    fireEvent.click(await screen.findByLabelText('编辑名称'));
    expect(await screen.findByText('编辑提供商名称')).toBeTruthy();
    const nameInput = screen.getByLabelText('提供商名称');
    fireEvent.change(nameInput, { target: { value: '新名称' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(upsertModelProvider).toHaveBeenCalled();
      const saved = upsertModelProvider.mock.calls.at(-1)?.[0] as { name: string };
      expect(saved.name).toBe('新名称');
    });
  });

  it('hides delete for builtin providers and shows confirm for custom ones', async () => {
    settingsState.config = {
      model_providers: [
        {
          id: 'ds-1',
          name: 'DeepSeek',
          enabled: false,
          api_key: '',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://api.deepseek.com',
              api_key_override: null,
              codex_needs_proxy: false,
            },
          ],
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
          default_model: 'deepseek-v4-flash',
          builtin_template_id: 'deepseek',
          opencode_provider_key: 'deepseek',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
        {
          id: 'custom-1',
          name: '测试1',
          enabled: false,
          api_key: 'sk-test',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://example.com',
              api_key_override: null,
              codex_needs_proxy: true,
            },
          ],
          models: [{ id: 'default-model', name: 'Default Model' }],
          default_model: 'default-model',
          builtin_template_id: null,
          opencode_provider_key: 'codemux-openai',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
      ],
      active_provider_id: null,
    };

    const { container } = render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getAllByText('深度求索').length).toBeGreaterThan(0);
    });

    const listEl = container.querySelector('.overflow-y-auto.px-2') as HTMLElement;
    fireEvent.click(within(listEl).getByText('深度求索'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    });

    fireEvent.click(within(listEl).getByText('测试1'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText('删除供应商')).toBeTruthy();
    expect(screen.getByText(/确认删除供应商「测试1」/)).toBeTruthy();
  });

  it('shows green dot only for enabled providers and keeps disabled customs last', async () => {
    settingsState.config = {
      model_providers: [
        {
          id: 'custom-1',
          name: '测试1',
          enabled: false,
          api_key: 'sk-test',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://example.com',
              api_key_override: null,
              codex_needs_proxy: true,
            },
          ],
          models: [{ id: 'default-model', name: 'Default Model' }],
          default_model: 'default-model',
          builtin_template_id: null,
          opencode_provider_key: 'codemux-openai',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
        {
          id: 'ds-1',
          name: 'DeepSeek',
          enabled: true,
          api_key: 'sk-ds',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://api.deepseek.com',
              api_key_override: null,
              codex_needs_proxy: false,
            },
          ],
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
          default_model: 'deepseek-v4-flash',
          builtin_template_id: 'deepseek',
          opencode_provider_key: 'deepseek',
          opencode_npm: '@ai-sdk/openai-compatible',
        },
      ],
      active_provider_id: null,
    };

    const { container } = render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByText('测试1')).toBeTruthy();
    });

    const listEl = container.querySelector('.overflow-y-auto.px-2') as HTMLElement;
    const names = within(listEl)
      .getAllByRole('button')
      .map((btn) => btn.textContent)
      .filter((text) => text && !text.includes('添加服务商'));

    expect(names[0]).toContain('深度求索');
    expect(names[names.length - 1]).toContain('测试1');

    const customBtn = within(listEl).getByText('测试1').closest('button')!;
    const deepseekBtn = within(listEl).getByText('深度求索').closest('button')!;
    expect(customBtn.querySelector('.bg-emerald-500')).toBeNull();
    expect(deepseekBtn.querySelector('.bg-emerald-500')).toBeTruthy();
  });

  it('falls back to builtin catalog when fetch fails', async () => {
    fetchProviderModels.mockRejectedValueOnce(new Error('认证失败'));
    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /获取模型列表/ })).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('保存可留空，启用时必填'), {
      target: { value: 'sk-bad' },
    });
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));

    expect(await screen.findByText('系统内置')).toBeTruthy();
    expect(screen.getByText('DeepSeek V4 Flash')).toBeTruthy();
    expect(screen.getByText('DeepSeek V4 Pro')).toBeTruthy();
  });

  it('shows protocol-gated model more settings', async () => {
    settingsState.config = {
      model_providers: [
        {
          id: 'openai-only',
          name: 'OpenAI Only',
          enabled: true,
          api_key: 'sk-test',
          endpoints: [
            {
              protocol: 'openai_compatible',
              base_url: 'https://api.openai.com/v1',
              api_key_override: null,
              codex_needs_proxy: false,
            },
          ],
          models: [{ id: 'gpt-5', name: 'GPT-5' }],
          default_model: 'gpt-5',
          builtin_template_id: null,
          opencode_provider_key: null,
          opencode_npm: null,
        },
      ],
      active_provider_id: 'openai-only',
    };

    render(<ProviderConfigPanel />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('gpt-5')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /设置模型 gpt-5/ })).toBeTruthy();
    expect(screen.queryByText('编辑模型')).toBeNull();
    expect(screen.queryByText('上下文窗口')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /设置模型 gpt-5/ }));

    expect(await screen.findByText('编辑模型')).toBeTruthy();
    expect(screen.getByText('上下文窗口')).toBeTruthy();
    expect(screen.getByText('最大输入 Token')).toBeTruthy();
    expect(screen.getByText('最大输出 Token')).toBeTruthy();
    expect(screen.queryByText('1M 上下文')).toBeNull();
    expect(screen.queryByText('模型类型')).toBeNull();
  });
});
