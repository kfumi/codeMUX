// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { AgentPanel } from './AgentPanel';

const { ensureSessionMock, updateProviderMock } = vi.hoisted(() => ({
  ensureSessionMock: vi.fn(() => Promise.resolve()),
  updateProviderMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    ensureSession: ensureSessionMock,
    getProxyPort: vi.fn(() => Promise.resolve(null)),
    deleteClaudeSessionFiles: vi.fn(),
    resetSession: vi.fn(),
  },
  sessionApi: {
    updateProvider: updateProviderMock,
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
  CodeMuxComposer: ({ modelSelector, permissionSelector }: { modelSelector?: React.ReactNode; permissionSelector?: React.ReactNode }) => (
    <div data-testid="composer">
      {modelSelector}
      {permissionSelector}
    </div>
  ),
}));

vi.mock('./assistant-ui/CodeMuxModelSelector', () => ({
  CodeMuxModelSelector: ({ providers, providerId, onProviderChange }: any) => (
    <button
      type="button"
      data-testid="model-selector"
      data-provider-id={providerId}
      data-provider-count={providers?.length ?? 0}
      onClick={() => onProviderChange?.('provider-2', 'claude-opus-4-1')}
    >
      切换供应商
    </button>
  ),
}));

describe('AgentPanel session bootstrapping', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    ensureSessionMock.mockClear();
    updateProviderMock.mockClear();

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
      },
    }));

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
  });
  it('persists provider and default model changes for the active session', async () => {
    useAgentStore.setState({ isRunning: { 'session-running': false } });

    render(<AgentPanel sessionId="session-running" />);

    expect(screen.getByTestId('model-selector').dataset.providerId).toBe('provider-1');
    expect(screen.getByTestId('model-selector').dataset.providerCount).toBe('2');
    screen.getByTestId('model-selector').click();

    await waitFor(() => {
      expect(updateProviderMock).toHaveBeenCalledWith('session-running', 'provider-2', 'claude-opus-4-1', 'medium');
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      provider_id: 'provider-2',
      model: 'claude-opus-4-1',
      reasoning_effort: 'medium',
    });
  });
});
