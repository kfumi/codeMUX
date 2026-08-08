// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      models: { id: string; group?: string }[];
      onValueChange?: (value: string) => void;
    }) => (
      <div
        data-models={models.map((model) => model.id).join(',')}
        data-groups={[...new Set(models.map((model) => model.group).filter(Boolean))].join(',')}
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
    Effort: ({ label }: { label?: string }) => <div data-testid="selector-effort">{label}</div>,
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
        reasoningEffort="medium"
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
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('selector-search')).toBeTruthy();
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
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('choose-snapshot'));
    expect(onChange).toHaveBeenCalledWith('snapshot-only-model', 'provider-2');
  });
});
