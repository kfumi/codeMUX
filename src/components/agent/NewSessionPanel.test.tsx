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
// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { useAgentStore } from '../../stores/agentStore';
import type { AgentModelSelectorProps } from './AgentModelSelector';

const freeCtl = vi.hoisted(() => ({ list: [] as Array<{
  id: string;
  modelId: string;
  providerId: string;
  providerTemplateId: string | null;
  name: string;
  group: string;
  efforts: boolean;
  source: 'catalog';
}> }));
const pendingCtl = vi.hoisted(() => ({ value: false }));

vi.mock('../../hooks/useAgentModels', () => ({
  useAgentModels: (
    _agentKind: AgentKind,
    providers: ModelProvider[] | ModelProvider | null,
  ) => {
    const list = !providers ? [] : Array.isArray(providers) ? providers : [providers];
    const base = list.flatMap((provider) =>
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
    );
    // freeCtl 模拟 opencode 免费目录的异步到达：默认空（pending），用例按需填入。
    const free = _agentKind === 'opencode' ? freeCtl.list : [];
    return {
      isLoading: false,
      models: [...base, ...free],
      freePending: pendingCtl.value && _agentKind === 'opencode',
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
    freeCtl.list = [];
    pendingCtl.value = false;
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

  it('uses the configured pi default model when starting a new conversation', () => {
    useNewSessionStore.setState({ selectedAgentKind: 'pi' });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              pi: {
                default_provider_id: 'provider-1',
                default_model: 'claude-opus-4-1',
              },
            },
          }
        : null,
    }));
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(useNewSessionStore.getState().selectedModel).toBe('claude-opus-4-1');
    expect(useNewSessionStore.getState().selectedProviderId).toBe('provider-1');
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

  it('does not persist fallback when configured opencode free default is not in model list yet', () => {
    // Cold start: free catalog async, provider list only. Old logic persisted models[0] into store,
    // shadowing configured free default forever (first chat wrong, second correct via warm cache).
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    render(<NewSessionPanel onSubmit={vi.fn()} />);
    // Must stay null (follow config), not fallback to provider-1 first model.
    expect(useNewSessionStore.getState().selectedModel).toBeNull();
    expect(useNewSessionStore.getState().selectedProviderId).toBeNull();
  });

  it('sends configured free default when user submits before free catalog arrives', async () => {
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    const onSubmit = vi.fn(async () => {});
    render(<NewSessionPanel onSubmit={onSubmit} />);
    const send = composerProps.find((entry) => typeof entry.onSend === 'function')?.onSend;
    expect(send).toBeTypeOf('function');
    await send?.({ text: 'hello' });
    expect(onSubmit).toHaveBeenCalled();
    // handleSend must correct store to configured default, not effective fallback.
    expect(useNewSessionStore.getState().selectedModel).toBe('free-model-x');
    expect(useNewSessionStore.getState().selectedProviderId).toBe('opencode-free');
  });

  it('snaps to configured free default when the free catalog arrives late', () => {
    // 动态复现冷启动：挂载时免费目录还没到（仅供应商模型），之后到达。
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    const { rerender } = render(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(useNewSessionStore.getState().selectedModel).toBeNull();
    freeCtl.list = [
      {
        id: 'opencode-free::free-model-x',
        modelId: 'free-model-x',
        providerId: 'opencode-free',
        providerTemplateId: 'opencode',
        name: 'free-model-x',
        group: 'OpenCode 免费模型',
        efforts: false,
        source: 'catalog' as const,
      },
    ];
    rerender(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(useNewSessionStore.getState().selectedModel).toBe('free-model-x');
    expect(useNewSessionStore.getState().selectedProviderId).toBe('opencode-free');
  });

  it('keeps an explicit user choice when the free catalog arrives late', () => {
    // 用户手动选过的值：免费目录后到也不许抢回配置默认值。
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    const { rerender } = render(<NewSessionPanel onSubmit={vi.fn()} />);
    // 通过模型选择器手动选第一个供应商模型（走 handleModelChange，标记为用户选择）。
    fireEvent.change(screen.getByRole('combobox', { name: 'Models' }), {
      target: { value: 'claude-sonnet-4-20250514' },
    });
    expect(useNewSessionStore.getState().selectedModel).toBe('claude-sonnet-4-20250514');
    freeCtl.list = [
      {
        id: 'opencode-free::free-model-x',
        modelId: 'free-model-x',
        providerId: 'opencode-free',
        providerTemplateId: 'opencode',
        name: 'free-model-x',
        group: 'OpenCode 免费模型',
        efforts: false,
        source: 'catalog' as const,
      },
    ];
    rerender(<NewSessionPanel onSubmit={vi.fn()} />);
    expect(useNewSessionStore.getState().selectedModel).toBe('claude-sonnet-4-20250514');
    expect(useNewSessionStore.getState().selectedProviderId).toBe('provider-1');
  });

  it('blocks sending while the configured free default is still pending', async () => {
    // 免费目录在途：发送门槛挂起，composer 禁用，发送直接吞掉，不会带着兜底发出。
    pendingCtl.value = true;
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    const onSubmit = vi.fn(async () => {});
    render(<NewSessionPanel onSubmit={onSubmit} />);
    const composer = [...composerProps].reverse().find((entry) => entry.sessionId === 'new-session-draft');
    expect(composer?.disabled).toBe(true);
    // 等待期选择器槽位是加载占位，不挂真实选择器：首屏看不到错误的第一个模型。
    expect((composer as any)?.modelSelector?.type).toBe('span');
    const send = composerProps.find((entry) => typeof entry.onSend === 'function')?.onSend;
    await send?.({ text: 'hello' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useNewSessionStore.getState().selectedModel).toBeNull();
  });

  it('sends the configured free default once the pending catalog settles', async () => {
    pendingCtl.value = true;
    useNewSessionStore.setState({ selectedAgentKind: 'opencode', selectedModel: null, selectedProviderId: null });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              opencode: {
                default_provider_id: 'opencode-free',
                default_model: 'free-model-x',
              },
            },
          }
        : null,
    }));
    const onSubmit = vi.fn(async () => {});
    const { rerender } = render(<NewSessionPanel onSubmit={onSubmit} />);
    pendingCtl.value = false;
    freeCtl.list = [
      {
        id: 'opencode-free::free-model-x',
        modelId: 'free-model-x',
        providerId: 'opencode-free',
        providerTemplateId: 'opencode',
        name: 'free-model-x',
        group: 'OpenCode 免费模型',
        efforts: false,
        source: 'catalog' as const,
      },
    ];
    rerender(<NewSessionPanel onSubmit={onSubmit} />);
    const composer = [...composerProps].reverse().find((entry) => entry.sessionId === 'new-session-draft');
    expect(composer?.disabled).toBe(false);
    expect((composer as any)?.modelSelector?.type).not.toBe('span');
    // 取最后一次渲染的 onSend：首渲染闭包里的 hasUsableProvider 还是等待中的旧值。
    const send = [...composerProps].reverse().find((entry) => typeof entry.onSend === 'function')?.onSend;
    await send?.({ text: 'hello' });
    expect(onSubmit).toHaveBeenCalled();
    expect(useNewSessionStore.getState().selectedModel).toBe('free-model-x');
    expect(useNewSessionStore.getState().selectedProviderId).toBe('opencode-free');
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
