// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAui } from '@assistant-ui/react';
import { useAgentModels } from '../../hooks/useAgentModels';
import { AgentModelSelector } from './AgentModelSelector';

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
        activeProfile={null}
        activeProfileId={null}
        value="gpt-5"
        onChange={vi.fn()}
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.getByTestId('selector-trigger')).toHaveProperty('disabled', true);
  });

  it('registers reasoning effort only when the selected model supports efforts', () => {
    const cleanup = vi.fn();
    const register = vi.fn(() => cleanup);
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register }) } as never);
    mockedUseAgentModels.mockReturnValue({
      models: [
        { id: 'codex-model', name: 'Codex Model', efforts: true },
        { id: 'unsupported-model', name: 'Unsupported Model' },
      ],
      isLoading: false,
    });

    const { rerender } = render(
      <AgentModelSelector
        agentKind="codex"
        activeProfile={null}
        activeProfileId={null}
        value="unsupported-model"
        onChange={vi.fn()}
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    const unsupportedRegistration = register.mock.calls.at(-1)?.[0];
    expect(unsupportedRegistration.getModelContext()).toEqual({
      config: { modelName: 'unsupported-model' },
    });

    rerender(
      <AgentModelSelector
        agentKind="codex"
        activeProfile={null}
        activeProfileId={null}
        value="codex-model"
        onChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
    const supportedRegistration = register.mock.calls.at(-1)?.[0];
    expect(supportedRegistration.getModelContext()).toEqual({
      config: { modelName: 'codex-model', reasoningEffort: 'high' },
    });
  });

  it('makes compact mode narrow and hides the effort display', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({
      models: [{ id: 'codex-model', name: 'Codex Model', efforts: true }],
      isLoading: false,
    });

    render(
      <AgentModelSelector
        agentKind="codex"
        activeProfile={null}
        activeProfileId={null}
        value="codex-model"
        onChange={vi.fn()}
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
        compact
      />,
    );

    const trigger = screen.getByTestId('selector-trigger');
    expect(trigger.getAttribute('data-size')).toBe('sm');
    expect(trigger.className).toContain('min-w-0');
    expect(trigger.className).toContain('max-w-32');
    expect(screen.getByText('selector').getAttribute('data-show-effort')).toBe('false');
  });

  it('only offers models returned for the active profile and rejects snapshot-only changes', () => {
    mockedUseAui.mockReturnValue({ modelContext: () => ({ register: vi.fn() }) } as never);
    mockedUseAgentModels.mockReturnValue({
      models: [{ id: 'global-model', name: 'Global Model' }],
      isLoading: false,
    });
    const onChange = vi.fn();

    render(
      <AgentModelSelector
        agentKind="claude_code"
        activeProfile={{ id: 'global-profile' } as never}
        activeProfileId="global-profile"
        value="global-model"
        contextModel="snapshot-only-model"
        onChange={onChange}
        reasoningEffort="medium"
        onReasoningEffortChange={vi.fn()}
      />,
    );

    expect(screen.getByText('selector').parentElement?.parentElement?.dataset.models).toBe('global-model');
    fireEvent.click(screen.getByTestId('choose-snapshot'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
