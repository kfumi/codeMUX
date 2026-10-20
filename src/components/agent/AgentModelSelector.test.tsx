// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useAui } from '@assistant-ui/react';
import { useAgentModels } from '../../hooks/useAgentModels';
import type { ModelProvider } from '../../types/provider';
import { AgentModelSelector } from './AgentModelSelector';

vi.mock('@assistant-ui/react', () => ({
  useAui: vi.fn(),
}));

vi.mock('../../hooks/useAgentModels', () => ({
  useAgentModels: vi.fn(),
  encodeModelSelectorValue: (providerId: string, modelId: string) => `${providerId}::${modelId}`,
  decodeModelSelectorValue: (value: string) => {
    const separator = value.indexOf('::');
    if (separator <= 0) return null;
    return { providerId: value.slice(0, separator), modelId: value.slice(separator + 2) };
  },
}));

vi.mock('@/components/settings/ProviderBrandIcon', () => ({
  ProviderBrandIcon: ({ name }: { name?: string }) => <span data-testid="brand-icon">{name}</span>,
}));

vi.mock('@/components/model-selector', () => ({
  ModelSelector: {
    Root: ({
      children,
      models,
      onValueChange,
    }: {
      children: React.ReactNode;
      models: { id: string; group?: string; efforts?: unknown }[];
      onValueChange?: (value: string) => void;
    }) => (
      <div
        data-testid="selector-root"
        data-models={models.map((model) => model.id).join(',')}
        data-groups={[...new Set(models.map((model) => model.group).filter(Boolean))].join(',')}
        // What the host hands ModelSelector as each model's levels. It resolves
        // the current level against these, so the raw `efforts` flag is not
        // enough — see the free-model regression test below.
        data-efforts={models
          .map((model) =>
            Array.isArray(model.efforts)
              ? model.efforts.map((level: { id: string }) => level.id).join('|')
              : String(model.efforts ?? 'none'),
          )
          .join(',')}
      >
        {onValueChange ? (
          <button
            type="button"
            data-testid="choose-snapshot"
            onClick={() => onValueChange?.('provider-2::snapshot-only-model')}
          />
        ) : null}
        {children}
      </div>
    ),
    Trigger: ({
      children,
      disabled,
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
    }) => (
      <button type="button" data-testid="selector-trigger" disabled={disabled}>
        {children ?? 'selector'}
      </button>
    ),
    Value: ({ hideName }: { hideName?: boolean }) => (
      <span data-testid="selector-value" data-hide-name={hideName ? 'true' : 'false'}>
        selector-value
      </span>
    ),
    Content: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="selector-content">{children}</div>
    ),
    Search: ({ placeholder }: { placeholder?: string }) => (
      <input data-testid="selector-search" placeholder={placeholder} />
    ),
    List: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="selector-list">{children}</div>
    ),
    Empty: () => <div>empty</div>,
    Group: ({
      heading,
      children,
    }: {
      heading?: string;
      children?: React.ReactNode;
    }) => (
      <div data-testid="selector-group" data-heading={heading}>
        {children}
      </div>
    ),
    Item: ({ model }: { model: { id: string; name: string } }) => (
      <div data-testid="selector-item">{model.name}</div>
    ),
    // `options` is the ladder the host resolved; `none` means it handed the
    // decision to ModelSelector's own context.
    Effort: ({
      label,
      options,
    }: {
      label?: string;
      options?: { id: string }[];
    }) => (
      <div
        data-testid="selector-effort"
        data-label={label}
        data-options={options ? options.map((option) => option.id).join(',') : 'none'}
      />
    ),
  },
}));

const mockedUseAui = vi.mocked(useAui);
const mockedUseAgentModels = vi.mocked(useAgentModels);

const sampleProviders: ModelProvider[] = [
  {
    id: 'provider-1',
    name: 'DeepSeek',
    enabled: true,
    api_key: 'sk',
    endpoints: [{ protocol: 'openai_compatible', base_url: 'https://api.deepseek.com' }],
    models: [{ id: 'gpt-5' }],
    default_model: 'gpt-5',
  },
];

const groupedModels = [
  {
    id: 'provider-1::gpt-5',
    modelId: 'gpt-5',
    providerId: 'provider-1',
    providerTemplateId: 'deepseek',
    name: 'GPT-5',
    group: '深度求索',
    efforts: true,
  },
  {
    id: 'provider-2::snapshot-only-model',
    modelId: 'snapshot-only-model',
    providerId: 'provider-2',
    providerTemplateId: 'openai',
    name: 'Snapshot',
    group: 'OpenAI',
    efforts: true,
  },
];

describe('AgentModelSelector', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('disables the selector while models are loading', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: [], isLoading: true });

    render(
      <AgentModelSelector
        agentKind="codex"
        providers={[]}
        activeProviderId={null}
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.getByTestId('selector-trigger')).toHaveProperty('disabled', true);
  });

  it('renders search, provider filters, and grouped lists', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });

    render(
      <AgentModelSelector
        agentKind="codex"
        providers={sampleProviders}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('selector-search')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '思考强度' })).toBeTruthy();
    expect(screen.queryByTestId('selector-effort')).toBeNull();
    expect(screen.getByRole('button', { name: '全部' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /深度求索/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /OpenAI/ })).toBeTruthy();
    expect(screen.getAllByTestId('selector-group').map((node) => node.getAttribute('data-heading'))).toEqual([
      '深度求索',
      'OpenAI',
    ]);

    fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }));
    expect(screen.getAllByTestId('selector-group')).toHaveLength(1);
    expect(screen.getByTestId('selector-group').getAttribute('data-heading')).toBe('OpenAI');
  });

  it('calls onChange with model and provider when a model is chosen', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });
    const onChange = vi.fn();

    render(
      <AgentModelSelector
        agentKind="codex"
        providers={sampleProviders}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={onChange}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('choose-snapshot'));
    expect(onChange).toHaveBeenCalledWith('snapshot-only-model', 'provider-2');
  });

  it('hides the model name in compact toolbars', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });

    render(
      <AgentModelSelector
        agentKind="codex"
        providers={sampleProviders}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
        compact
      />,
    );

    expect(screen.getByTestId('selector-value').getAttribute('data-hide-name')).toBe('true');
  });

  it('offers every thinking level when the model declares none', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });

    render(
      <AgentModelSelector
        agentKind="pi"
        providers={sampleProviders}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }));
    for (const label of ['关闭', '低', '中', '高', '极高', '最高']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
  });

  it('narrows the thinking levels to what the selected model declares', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });

    render(
      <AgentModelSelector
        agentKind="pi"
        providers={[
          {
            ...sampleProviders[0],
            models: [{ id: 'gpt-5', thinking_levels: ['none', 'low', 'high'] }],
          },
        ]}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }));
    expect(screen.getByRole('option', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '极高' })).toBeNull();
    expect(screen.queryByRole('option', { name: '最高' })).toBeNull();
  });

  it('scopes the level lookup to the selected provider', () => {
    // The same model id can sit under two providers with different
    // capabilities; a lookup by model id alone would pick the wrong one.
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({
      models: [
        { ...groupedModels[0] },
        { ...groupedModels[0], id: 'provider-2::gpt-5', providerId: 'provider-2' },
      ],
      isLoading: false,
    });

    render(
      <AgentModelSelector
        agentKind="pi"
        providers={[
          {
            ...sampleProviders[0],
            models: [{ id: 'gpt-5', thinking_levels: ['none'] }],
          },
          {
            ...sampleProviders[0],
            id: 'provider-2',
            models: [{ id: 'gpt-5', thinking_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
          },
        ]}
        activeProviderId="provider-2"
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }));
    // provider-2 declares the full ladder, so 极高 must be present even though
    // provider-1's copy of the same model id declares none.
    expect(screen.getByRole('option', { name: '极高' })).toBeTruthy();
  });

  // The slider is opt-in. Every host except the conversation composer must keep
  // the standalone dropdown exactly as it was.
  describe('effortControl', () => {
    const renderWith = (effortControl?: 'dropdown' | 'slider') => {
      mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
      mockedUseAgentModels.mockReturnValue({ models: groupedModels, isLoading: false });

      render(
        <AgentModelSelector
          agentKind="pi"
          providers={sampleProviders}
          activeProviderId="provider-1"
          value="gpt-5"
          onChange={vi.fn()}
          reasoningEffort="high"
          onReasoningEffortChange={vi.fn()}
          {...(effortControl ? { effortControl } : {})}
        />,
      );
    };

    it('defaults to the standalone dropdown', () => {
      renderWith();

      expect(screen.getByRole('combobox', { name: '思考强度' })).toBeTruthy();
      expect(screen.queryByTestId('selector-effort')).toBeNull();
    });

    it('moves the control into the popover when asked for a slider', () => {
      renderWith('slider');

      expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
      expect(screen.getByTestId('selector-effort')).toBeTruthy();
    });

    it('still offers the full ladder for a model that declares no levels', () => {
      // Regression: free catalog models are flagged `efforts: false` as a
      // conservative default and declare no `thinking_levels`. Deferring to that
      // flag made the slider vanish on the very models the new-session page
      // starts on, while the dropdown had always shown all six.
      mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
      mockedUseAgentModels.mockReturnValue({
        models: [
          {
            id: 'opencode-free::deepseek-v4.1-flash-free',
            modelId: 'deepseek-v4.1-flash-free',
            providerId: 'opencode-free',
            providerTemplateId: 'opencode',
            name: 'Deepseek V4.1 Flash Free',
            group: 'OpenCode 免费模型',
            efforts: false,
          },
        ],
        isLoading: false,
      });

      render(
        <AgentModelSelector
          agentKind="pi"
          providers={[]}
          activeProviderId={null}
          value="opencode-free::deepseek-v4.1-flash-free"
          onChange={vi.fn()}
          reasoningEffort="high"
          onReasoningEffortChange={vi.fn()}
          effortControl="slider"
        />,
      );

      expect(screen.getByTestId('selector-effort').getAttribute('data-options')).toBe(
        'none,low,medium,high,xhigh,max',
      );
      // ModelSelector must get the same ladder, not the `false` flag: it resolves
      // the session's level against these, so the flag would leave the slider
      // pinned to the bottom of the range.
      expect(screen.getByTestId('selector-root').getAttribute('data-efforts')).toBe(
        'none|low|medium|high|xhigh|max',
      );
    });
  });
});
