// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAui } from '@assistant-ui/react';
import { useAgentModels } from '../../hooks/useAgentModels';
import { AgentModelSelector } from './AgentModelSelector';
import type { ModelProvider } from '../../types/provider';

vi.mock('@assistant-ui/react', () => ({
  useAui: vi.fn(),
}));

vi.mock('../../hooks/useAgentModels', () => ({
  useAgentModels: vi.fn(),
}));

vi.mock('@/components/model-selector', () => ({
  ModelSelector: {
    Root: ({ children, models, onValueChange }: { children: React.ReactNode; models: { id: string }[]; onValueChange?: (value: string) => void }) => (
      <div data-models={models.map((model) => model.id).join(',')}>
        {onValueChange ? <button type="button" data-testid="choose-snapshot" onClick={() => onValueChange?.('snapshot-only-model')} /> : null}
        {children}
      </div>
    ),
    Trigger: ({
      children,
      className,
      disabled,
      size,
    }: {
      children?: React.ReactNode;
      className?: string;
      disabled?: boolean;
      size?: string;
    }) => (
      <button type="button" data-testid="selector-trigger" className={className} data-size={size} disabled={disabled}>
        {children ?? 'selector'}
      </button>
    ),
    Value: ({
      className,
      showEffort,
    }: {
      className?: string;
      showEffort?: boolean;
    }) => (
      <span className={className} data-show-effort={String(showEffort)}>
        selector
      </span>
    ),
    Content: () => null,
  },
}));

const mockedUseAui = vi.mocked(useAui);
const mockedUseAgentModels = vi.mocked(useAgentModels);

const sampleProvider: ModelProvider = {
  id: 'provider-1',
  name: 'DeepSeek',
  enabled: true,
  api_key: 'sk',
  endpoints: [{ protocol: 'openai_compatible', base_url: 'https://api.deepseek.com' }],
  models: [{ id: 'gpt-5' }],
  default_model: 'gpt-5',
};

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
        activeProvider={null}
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

  it('calls onChange when a model is chosen', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({
      models: [
        { id: 'gpt-5', name: 'GPT-5', efforts: true },
        { id: 'snapshot-only-model', name: 'Snapshot', efforts: true },
      ],
      isLoading: false,
    });
    const onChange = vi.fn();

    render(
      <AgentModelSelector
        agentKind="codex"
        activeProvider={sampleProvider}
        activeProviderId="provider-1"
        value="gpt-5"
        onChange={onChange}
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('choose-snapshot'));
    expect(onChange).toHaveBeenCalledWith('snapshot-only-model');
  });
});
