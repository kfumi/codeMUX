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
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ disabled }: { disabled?: boolean }) => (
      <button type="button" disabled={disabled}>
        selector
      </button>
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

    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });

  it('registers reasoning effort only when the selected model supports efforts', () => {
    const register = vi.fn(() => vi.fn());
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

    const supportedRegistration = register.mock.calls.at(-1)?.[0];
    expect(supportedRegistration.getModelContext()).toEqual({
      config: { modelName: 'codex-model', reasoningEffort: 'high' },
    });
  });
});
