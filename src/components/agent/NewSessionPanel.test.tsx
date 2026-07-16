// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionStore } from '../../stores/newSessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentKind } from '../../types/session';
import { NewSessionPanel } from './NewSessionPanel';

const composerProps: Array<{
  agentKind?: AgentKind;
  placeholder?: string;
  projectPath?: string | null;
  disabled?: boolean;
  disabledMessage?: string;
  onSend?: (content: string) => Promise<void>;
}> = [];

vi.mock('./assistant-ui/CodeMuxAssistantRuntime', () => ({
  CodeMuxAssistantRuntimeProvider: ({ children, agentKind, onSend }: any) => {
    composerProps.push({ agentKind, onSend });
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

vi.mock('./assistant-ui/CodeMuxModelSelector', () => ({
  CodeMuxModelSelector: ({ models, providers, providerId, onChange, onProviderChange }: any) => (
    <div>
      <select aria-label="Providers" value={providerId ?? ''} onChange={(event) => onProviderChange?.(event.target.value, 'gpt-5')}>
        {providers?.map((provider: any) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
      <select aria-label="Models" onChange={(event) => onChange(event.target.value)}>
        {models.map((model: string) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </div>
  ),
}));

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
      selectedProviderId: null,
      selectedModel: null,
      selectedReasoningEffort: 'medium',
      draftProjectId: null,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [{
          id: 'provider-1',
          name: 'Provider',
          api_key: 'key',
          anthropic_base_url: 'https://api.anthropic.com',
          openai_base_url: 'https://api.openai.com/v1',
          default_model: 'claude-sonnet-4-20250514',
          models: ['claude-sonnet-4-20250514', 'claude-opus-4-1'],
        }, {
          id: 'provider-2',
          name: 'Provider 2',
          api_key: 'key-2',
          anthropic_base_url: 'https://provider-2.example',
          openai_base_url: 'https://provider-2.example/v1',
          default_model: 'gpt-5',
          models: ['gpt-5', 'gpt-5-mini'],
        }],
        active_provider_id: 'provider-1',
        agent_defaults: { default_agent_kind: 'claude_code' },
        agent_configs: {
          claude_code: { executable_mode: 'auto', resume_sessions: true },
          codex: { sdk_mode: 'responses' },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
        default_open_target: 'file_explorer',
        agent_profile_registry: {
          profiles: [{
            id: 'profile-1', agent_kind: 'claude_code', name: 'Provider', note: '',
            models: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-opus-4-1' }], default_model: 'claude-sonnet-4-20250514',
            native_config: { type: 'claude_code', api_key: '', anthropic_base_url: 'https://api.anthropic.com' },
          }, {
            id: 'profile-2', agent_kind: 'claude_code', name: 'Provider 2', note: '',
            models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }], default_model: 'gpt-5',
            native_config: { type: 'claude_code', api_key: '', anthropic_base_url: 'https://provider-2.example' },
          }],
          active_profile_ids: { claude_code: 'profile-1' },
        },
      },
      activateAgentProfile: vi.fn(() => Promise.resolve()),
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('centers the new conversation prompt and reuses the shared composer', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(screen.getByText('我们应该做什么？')).toBeTruthy();
    expect(screen.getByText('Mock Composer')).toBeTruthy();
    expect(composerProps.at(-1)?.placeholder).toBe('给 Claude Code 发送第一条任务指令... (@ 引用文件, / 查看命令)');
  });

  it('uses the project folder name in the prompt when starting from a project', () => {
    useNewSessionStore.setState({ draftProjectId: 'project-1' });

    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(screen.getByText('我们应该在 codeMUX 中构建什么？')).toBeTruthy();
  });

  it('passes the selected agent to the composer when Codex is selected', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Claude Code' }).find((element) => element.tagName === 'BUTTON')!);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

    expect(composerProps.at(-1)?.agentKind).toBe('codex');
    expect(composerProps.at(-1)?.placeholder).toBe('给 Codex 发送第一条任务指令... (@ 引用文件, / 查看命令)');
  });

  it('passes the draft project path so @ file search is available', () => {
    useNewSessionStore.setState({ draftProjectId: 'project-1' });

    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(composerProps.at(-1)?.projectPath).toBe('D:/project/ai-code/codeMUX');
    expect(screen.queryByText('D:/project/ai-code/codeMUX')).toBeNull();
  });

  it('lets the draft choose a provider model', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Models' }), {
      target: { value: 'claude-opus-4-1' },
    });

    expect(useNewSessionStore.getState().selectedModel).toBe('claude-opus-4-1');
  });

  it('lets the draft choose a provider and its first model', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: {
          ...state.config.agent_profile_registry!,
          profiles: state.config.agent_profile_registry!.profiles.map((profile) =>
            profile.id === 'profile-2' ? { ...profile, default_model: '' } : profile,
          ),
        },
      } : null,
    }));
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Providers' }), {
      target: { value: 'profile-2' },
    });

    await vi.waitFor(() => {
      expect(useNewSessionStore.getState().selectedProviderId).toBe('profile-2');
      expect(useNewSessionStore.getState().selectedModel).toBe('gpt-5');
    });
  });

  it('submits through the shared runtime send handler', async () => {
    const onSubmit = vi.fn();

    render(<NewSessionPanel onSubmit={onSubmit} />);

    await composerProps[0]?.onSend?.('Ship the feature');

    expect(onSubmit).toHaveBeenCalledWith({ text: 'Ship the feature' });
  });

  it('allows a Claude conversation with the default local supplier', async () => {
    const onSubmit = vi.fn();
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: { profiles: [], active_profile_ids: {} },
      } : null,
    }));

    render(<NewSessionPanel onSubmit={onSubmit} />);

    expect(composerProps.at(-1)?.disabled).toBe(false);

    await composerProps[0]?.onSend?.('Ship the feature');

    expect(onSubmit).toHaveBeenCalledWith({ text: 'Ship the feature' });
  });

  it('keeps normal Codex plan mode draft sends as the original user text', async () => {
    const onSubmit = vi.fn();
    useNewSessionStore.setState({ selectedAgentKind: 'codex' });
    useSettingsStore.setState((state) => ({
      ...state,
      config: state.config ? {
        ...state.config,
        agent_profile_registry: {
          profiles: [
            ...(state.config.agent_profile_registry?.profiles ?? []),
            {
              id: 'codex-profile-1', agent_kind: 'codex', name: 'Codex 档案', note: '',
              models: [{ id: 'gpt-5' }], default_model: 'gpt-5',
              native_config: { type: 'codex', api_key: '', base_url: 'https://api.openai.com/v1' },
            },
          ],
          active_profile_ids: {
            ...(state.config.agent_profile_registry?.active_profile_ids ?? {}),
            codex: 'codex-profile-1',
          },
        },
      } : null,
    }));

    render(<NewSessionPanel onSubmit={onSubmit} />);

    act(() => {
      useNewSessionStore.setState({ selectedPlanMode: 'on' });
    });

    const runtimeSend = [...composerProps].reverse().find((props) => props.onSend)?.onSend;
    await runtimeSend?.('Ship the feature');

    expect(onSubmit).toHaveBeenCalledWith({ text: 'Ship the feature' });
  });
});
