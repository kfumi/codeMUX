// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  CodeMuxModelSelector: ({ models, onChange }: any) => (
    <select aria-label="Models" onChange={(event) => onChange(event.target.value)}>
      {models.map((model: string) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
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

  it('submits through the shared runtime send handler', async () => {
    const onSubmit = vi.fn();

    render(<NewSessionPanel onSubmit={onSubmit} />);

    await composerProps[0]?.onSend?.('Ship the feature');

    expect(onSubmit).toHaveBeenCalledWith({ text: 'Ship the feature' });
  });
});
