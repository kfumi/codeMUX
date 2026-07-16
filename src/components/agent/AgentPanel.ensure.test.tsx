// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { AgentPanel } from './AgentPanel';

const { ensureSessionMock, setActiveAgentProfileModelMock } = vi.hoisted(() => ({
  ensureSessionMock: vi.fn(() => Promise.resolve()),
  setActiveAgentProfileModelMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    ensureSession: ensureSessionMock,
    getProxyPort: vi.fn(() => Promise.resolve(null)),
    deleteClaudeSessionFiles: vi.fn(),
    resetSession: vi.fn(),
  },
  sessionApi: {
    touch: vi.fn(() => Promise.resolve()),
    updateTitle: vi.fn(() => Promise.resolve()),
  },
  fileApi: {
    readFile: vi.fn(),
  },
}));

vi.mock('../assistant-ui/context-display', () => ({
  ContextDisplay: () => null,
}));

vi.mock('./TodoList', () => ({
  TodoList: () => null,
}));

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./assistant-ui/CodeMuxAssistantRuntime', () => ({
  CodeMuxAssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./assistant-ui/CodeMuxThread', () => ({
  CodeMuxThread: ({ footer }: { footer?: React.ReactNode }) => <div>{footer}</div>,
}));

vi.mock('./assistant-ui/CodeMuxComposer', () => ({
  CodeMuxComposer: ({ modelName, modelSelector, permissionSelector }: { modelName?: string; modelSelector?: React.ReactNode; permissionSelector?: React.ReactNode }) => (
    <div data-testid="composer">
      <span data-testid="composer-model">{modelName}</span>
      {modelSelector}
      {permissionSelector}
    </div>
  ),
}));

vi.mock('./AgentModelSelector', () => ({
  AgentModelSelector: ({ activeProfileId, value, contextModel, onChange }: { activeProfileId: string | null; value: string; contextModel?: string; onChange: (model: string) => void }) => (
    <div data-testid="model-selector" data-provider-id={activeProfileId ?? ''} data-model={value}>
      <span data-testid="model-context">{contextModel}</span>
      <button type="button" onClick={() => onChange('claude-sonnet-4-20250514')}>change model</button>
    </div>
  ),
}));

describe('AgentPanel session bootstrapping', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    ensureSessionMock.mockClear();
    setActiveAgentProfileModelMock.mockClear();

    useSessionStore.setState({
      sessions: [{
        id: 'session-running',
        title: 'Running session',
        agent_kind: 'claude_code',
        provider_id: null,
        model: 'claude-sonnet-4-20250514',
        mode: 'agent',
        project_id: null,
        created_at: '',
        updated_at: '',
      }],
      activeSessionId: 'session-running',
      isLoading: false,
      error: null,
    });

    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      isLoading: false,
      error: null,
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
          models: ['claude-sonnet-4-20250514'],
        }, {
          id: 'provider-2',
          name: 'Provider 2',
          api_key: 'key-2',
          anthropic_base_url: 'https://provider-2.example',
          openai_base_url: 'https://provider-2.example/v1',
          default_model: 'claude-opus-4-1',
          models: ['claude-opus-4-1'],
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
            id: 'profile-1', agent_kind: 'claude_code', name: 'Provider', note: '', models: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-opus-4-1' }], default_model: 'claude-opus-4-1',
            native_config: { type: 'claude_code', api_key: '', anthropic_base_url: 'https://api.anthropic.com' },
          }, {
            id: 'profile-2', agent_kind: 'claude_code', name: 'Provider 2', note: '', models: [{ id: 'claude-opus-4-1' }], default_model: 'claude-opus-4-1',
            native_config: { type: 'claude_code', api_key: '', anthropic_base_url: 'https://provider-2.example' },
          }],
          active_profile_ids: { claude_code: 'profile-1' },
        },
      },
    }));

    useSettingsStore.setState({ setActiveAgentProfileModel: setActiveAgentProfileModelMock });

    useAgentStore.setState({
      events: { 'session-running': [{ kind: 'user', data: { content: 'first prompt' } }] },
      eventTimestamps: { 'session-running': [Date.now()] },
      isRunning: { 'session-running': true },
      queryStartTime: { 'session-running': Date.now() },
      error: {},
      mcpRuntimeStatus: {},
      todos: {},
      streamingThinking: {},
      streamingText: {},
      forceStopped: {},
      streamingToolInputs: {},
      streamingToolMeta: {},
      streamingToolIndexMap: {},
      streamedToolUseIds: {},
      changedFiles: {},
      fileOriginals: {},
      acknowledgedFiles: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('does not re-ensure a session that is already running from a new-session send', async () => {
    render(<AgentPanel sessionId="session-running" />);

    await waitFor(() => {
      expect(ensureSessionMock).not.toHaveBeenCalled();
    });
  });

  it('keeps the permission selector enabled while the session is running', () => {
    render(<AgentPanel sessionId="session-running" />);

    expect(screen.getByTitle('变更前确认')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('model-selector').dataset.model).toBe('claude-opus-4-1');
  });
  it('uses global model options while preserving the saved session model for context', async () => {
    useSessionStore.setState((state) => ({
      ...state,
      sessions: state.sessions.map((session) => ({
        ...session,
        provider_id: 'profile-2',
        model: 'claude-opus-4-1',
      })),
    }));
    useAgentStore.setState({ isRunning: { 'session-running': false } });

    render(<AgentPanel sessionId="session-running" />);

    expect(screen.getByTestId('model-selector').dataset.providerId).toBe('profile-1');
    expect(screen.getByTestId('model-selector').dataset.model).toBe('claude-opus-4-1');
    expect(screen.getByTestId('model-context').textContent).toBe('claude-opus-4-1');
    expect(screen.getByTestId('composer-model').textContent).toBe('claude-opus-4-1');
    expect(screen.getByText('当前会话固定使用 Provider 2 / claude-opus-4-1；这里的切换只会应用到后续新建或重启的会话。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => {
      expect(setActiveAgentProfileModelMock).toHaveBeenCalledWith('claude_code', 'claude-sonnet-4-20250514');
    });
  });
});
