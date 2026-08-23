// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentKind } from '../../types/session';
import type { ModelProvider } from '../../types/provider';
import type { SlashCommand } from '../../lib/slashCommands';
import { NewSessionPanel } from './NewSessionPanel';
import type { AgentModelSelectorProps } from './AgentModelSelector';

vi.mock('../../hooks/useAgentModels', () => ({
  useAgentModels: (
    _agentKind: AgentKind,
    providers: ModelProvider[] | ModelProvider | null,
  ) => {
    const list = !providers ? [] : Array.isArray(providers) ? providers : [providers];
    return {
      isLoading: false,
      models: list.flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.id}::${model.id}`,
          modelId: model.id,
          providerId: provider.id,
          providerTemplateId: provider.builtin_template_id ?? null,
          name: model.id,
          group: provider.name,
          efforts: true,
          source: 'provider' as const,
        })),
      ),
    };
  },
}));

const composerProps: Array<{
  agentKind?: AgentKind;
  placeholder?: string;
  projectPath?: string | null;
  sessionId?: string;
  disabled?: boolean;
  onSend?: (content: unknown) => Promise<void>;
  onCommand?: (command: SlashCommand, args: string) => Promise<void>;
  planMode?: 'on' | 'off';
  onTogglePlanMode?: () => void;
  onActivatePlanMode?: () => void;
}> = [];

vi.mock('./assistant-ui/CodeMuxAssistantRuntime', () => ({
  CodeMuxAssistantRuntimeProvider: ({ children, agentKind, onSend, onCommand }: any) => {
    composerProps.push({ agentKind, onSend, onCommand });
    return <div>{children}</div>;
  },
}));

vi.mock('./assistant-ui/CodeMuxComposer', () => ({
  CodeMuxComposer: (props: any) => {
    composerProps.push(props);
    return (
      <div>
        <button type="button" onClick={() => props.onSend?.('Ship the feature')}>
          Mock Composer
        </button>
        {props.modelSelector}
      </div>
    );
  },
}));

vi.mock('./AgentModelSelector', () => ({
  AgentModelSelector: ({
    agentKind,
    providers,
    activeProviderId,
    value,
    reasoningEffort,
    onChange,
    onReasoningEffortChange,
    disabled,
  }: AgentModelSelectorProps) => {
    const activeProvider =
      providers.find((provider) => provider.id === activeProviderId) ?? providers[0] ?? null;
    return (
      <div data-agent-kind={agentKind}>
        <span data-testid="active-provider-id">{activeProviderId}</span>
        <select
          aria-label="Models"
          value={value}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value, activeProvider?.id ?? activeProviderId ?? '')
          }
        >
          {(activeProvider?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.id}
            </option>
          ))}
        </select>
        <select
          aria-label="思考强度"
          value={reasoningEffort}
          disabled={disabled}
          onChange={(event) => onReasoningEffortChange(event.target.value as any)}
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
    );
  },
}));

function sampleProvider(id: string, models: string[], protocol: 'anthropic' | 'openai_compatible' = 'anthropic'): ModelProvider {
  return {
    id,
    name: id,
    enabled: true,
    api_key: 'sk-test',
    endpoints: [
      {
        protocol,
        base_url: protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
        codex_needs_proxy: protocol === 'openai_compatible' ? true : null,
      },
      ...(protocol === 'anthropic'
        ? [{
            protocol: 'openai_compatible' as const,
            base_url: 'https://api.openai.com/v1',
            codex_needs_proxy: true,
          }]
        : []),
    ],
    models: models.map((modelId) => ({ id: modelId, name: modelId })),
    default_model: models[0] ?? '',
  };
}

describe('NewSessionPanel', () => {
  beforeEach(() => {
    composerProps.length = 0;
    useProjectStore.setState({
      projects: [
        { id: 'project-1', name: 'codeMUX', path: 'D:/project/ai-code/codeMUX', created_at: '', updated_at: '' },
      ],
    });
    usePreviewStore.setState({
      loadFileTree: vi.fn(),
      setProjectPath: vi.fn(),
      treeRoot: null,
      treeRootPath: null,
    });
    useNewSessionStore.setState({
      selectedAgentKind: 'claude_code',
      selectedModel: null,
      selectedProviderId: null,
      selectedReasoningEffort: 'high',
      selectedPermissionConfig: { kind: 'claude_code', permissionMode: 'default' },
      selectedPlanMode: 'off',
      draftProjectId: null,
      draftRevision: 0,
      isDraftOpen: false,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        model_providers: [
          sampleProvider('provider-1', ['claude-sonnet-4-20250514', 'claude-opus-4-1']),
          sampleProvider('provider-2', ['gpt-5', 'gpt-5-mini'], 'openai_compatible'),
        ],
        active_provider_id: 'provider-1',
        agent_defaults: { default_agent_kind: 'claude_code' },
        agent_configs: {
          claude_code: { executable_mode: 'auto', resume_sessions: true },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
        default_open_target: 'file_explorer',
        notifications: {
          system_enabled: true,
          sound_enabled: false,
          sound: 'ding',
        },
      },
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('centers the new conversation prompt and reuses the shared composer', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(screen.getByText('我们应该做什么？')).toBeTruthy();
    expect(screen.getByText('Mock Composer')).toBeTruthy();
    expect(composerProps.some((entry) => entry.sessionId === 'new-session-draft')).toBe(true);
  });

  it('clears the shared new-session composer draft after a successful submit', async () => {
    const { useAgentStore } = await import('../../stores/agentStore');
    useAgentStore.getState().saveComposerDraft('new-session-draft', '旧输入还在');

    const onSubmit = vi.fn(async () => {});
    render(<NewSessionPanel onSubmit={onSubmit} />);

    const send = composerProps.find((entry) => typeof entry.onSend === 'function')?.onSend;
    expect(send).toBeTypeOf('function');
    await send?.({ text: '开始新任务' });

    expect(onSubmit).toHaveBeenCalled();
    expect(useAgentStore.getState().getComposerDraft('new-session-draft')).toBe('');
  });

  it('uses the project folder name in the prompt when starting from a project', () => {
    useNewSessionStore.setState({ draftProjectId: 'project-1' });
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(screen.getByText('我们应该在 codeMUX 中构建什么？')).toBeTruthy();
  });

  it('lets the draft choose a model from the active provider', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Models' }), {
      target: { value: 'claude-opus-4-1' },
    });
    expect(useNewSessionStore.getState().selectedModel).toBe('claude-opus-4-1');
  });

  it('shows guidance when no usable provider is configured', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            model_providers: [],
            active_provider_id: null,
          }
        : null,
    }));
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(screen.getByText(/请先在设置 → 模型配置/)).toBeTruthy();
  });

  it('wires the + menu plan mode entry and active chip state into the draft', () => {
    useNewSessionStore.setState({ selectedAgentKind: 'codex' });
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    const lastComposer = () => [...composerProps].reverse()
      .find((entry) => entry.sessionId === 'new-session-draft');
    expect(lastComposer()?.planMode).toBe('off');

    act(() => {
      lastComposer()?.onActivatePlanMode?.();
    });
    expect(useNewSessionStore.getState().selectedPlanMode).toBe('on');
    expect(lastComposer()?.planMode).toBe('on');

    act(() => {
      lastComposer()?.onTogglePlanMode?.();
    });
    expect(useNewSessionStore.getState().selectedPlanMode).toBe('off');
  });
});
