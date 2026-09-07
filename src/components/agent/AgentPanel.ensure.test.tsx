// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ModelProvider } from '../../types/provider';
import { AgentPanel } from './AgentPanel';
import type { AgentModelSelectorProps } from './AgentModelSelector';

const { codeMuxThreadRenderMock, ensureSessionMock, updateProviderMock, updateReasoningEffortMock } = vi.hoisted(() => ({
  codeMuxThreadRenderMock: vi.fn(),
  ensureSessionMock: vi.fn(() => Promise.resolve()),
  updateProviderMock: vi.fn(() => Promise.resolve()),
  updateReasoningEffortMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    getTimeline: vi.fn(() => Promise.resolve({ events: [], hasMore: false })),
    patchSessionViaDaemon: vi.fn(() => Promise.resolve()),
    sendMessageViaDaemon: vi.fn(() => Promise.resolve()),
    interruptViaDaemon: vi.fn(() => Promise.resolve()),
    updateWorkingPath: vi.fn(() => Promise.resolve()),
    touchSession: vi.fn(() => Promise.resolve()),
    ensureAgentSession: ensureSessionMock,
    updateProvider: updateProviderMock,
    updateReasoningEffort: updateReasoningEffortMock,
  },
  ensureDaemonClient: vi.fn(() => Promise.resolve({
    getTimeline: vi.fn(() => Promise.resolve({ events: [], hasMore: false })),
    subscribeSession: vi.fn(() => () => undefined),
  })),
  getDaemonClientInitError: vi.fn(() => null),
  resetDaemonClient: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    ensureSession: ensureSessionMock,
    getProxyPort: vi.fn(() => Promise.resolve(null)),
    deleteClaudeSessionFiles: vi.fn(),
    resetSession: vi.fn(),
    loadClaudeSessionEvents: vi.fn(() => Promise.resolve([])),
    loadCodexSessionEvents: vi.fn(() => Promise.resolve([])),
    loadSessionEvents: vi.fn(() => Promise.resolve([])),
  },
  companionApi: {
    isSessionTurnActive: vi.fn(() => Promise.resolve(false)),
    getStatus: vi.fn(() => Promise.resolve({ port: 8787, enabled: false })),
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

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./assistant-ui/CodeMuxAssistantRuntime', () => ({
  CodeMuxAssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./assistant-ui/CodeMuxThread', () => ({
  CodeMuxThread: ({ footer }: { footer?: React.ReactNode }) => {
    codeMuxThreadRenderMock();
    return <div>{footer}</div>;
  },
}));

vi.mock('./assistant-ui/CodeMuxComposer', () => ({
  CodeMuxComposer: ({
    modelName,
    modelSelector,
    permissionSelector,
  }: {
    modelName?: string;
    modelSelector?: React.ReactNode;
    permissionSelector?: React.ReactNode;
  }) => (
    <div data-testid="composer">
      <span data-testid="composer-model">{modelName}</span>
      {modelSelector}
      {permissionSelector}
    </div>
  ),
}));

vi.mock('./AgentModelSelector', () => ({
  AgentModelSelector: ({
    agentKind,
    providers,
    activeProviderId,
    value,
    contextModel,
    reasoningEffort,
    onChange,
    onReasoningEffortChange,
    disabled,
  }: AgentModelSelectorProps) => (
    <div
      data-testid="model-selector"
      data-agent-kind={agentKind}
      data-has-provider={providers.length > 0 ? 'true' : 'false'}
      data-provider-id={activeProviderId ?? ''}
      data-model={value}
    >
      <span data-testid="model-context">{contextModel}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('claude-sonnet-4-20250514', activeProviderId ?? 'provider-1')}
      >
        change model
      </button>
      <button type="button" disabled={disabled} onClick={() => onReasoningEffortChange('high')}>
        change reasoning
      </button>
      <span data-testid="reasoning-effort">{reasoningEffort}</span>
    </div>
  ),
}));

function provider(id: string, models: string[]): ModelProvider {
  return {
    id,
    name: id,
    enabled: true,
    api_key: 'sk-test',
    endpoints: [
      { protocol: 'anthropic', base_url: 'https://api.anthropic.com' },
      { protocol: 'openai_compatible', base_url: 'https://api.openai.com/v1', codex_needs_proxy: false },
    ],
    models: models.map((modelId) => ({ id: modelId })),
    default_model: models[0] ?? '',
  };
}

describe('AgentPanel session bootstrapping', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    ensureSessionMock.mockClear();
    codeMuxThreadRenderMock.mockClear();
    updateProviderMock.mockClear();
    updateReasoningEffortMock.mockClear();

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
        model_providers: [
          provider('provider-1', ['claude-sonnet-4-20250514', 'claude-opus-4-1']),
          provider('provider-2', ['claude-opus-4-1']),
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
    expect(screen.getByRole('button', { name: '变更前确认' })).toHaveProperty('disabled', false);
    expect(screen.getByTestId('model-selector').dataset.model).toBe('claude-sonnet-4-20250514');
  });

  it('does not rerender the chat thread for streaming token updates', () => {
    render(<AgentPanel sessionId="session-running" />);
    const initialRenderCount = codeMuxThreadRenderMock.mock.calls.length;

    act(() => {
      useAgentStore.setState((state) => ({
        streamingThinking: {
          ...state.streamingThinking,
          'session-running': 'new thinking token',
        },
      }));
    });

    expect(codeMuxThreadRenderMock).toHaveBeenCalledTimes(initialRenderCount);
  });

  it('uses session provider when bound and updates provider on model change', async () => {
    useSessionStore.setState((state) => ({
      ...state,
      sessions: state.sessions.map((session) => ({
        ...session,
        provider_id: 'provider-2',
        model: 'claude-opus-4-1',
      })),
    }));
    useAgentStore.setState({ isRunning: { 'session-running': false } });

    render(<AgentPanel sessionId="session-running" />);

    expect(screen.getByTestId('model-selector').dataset.providerId).toBe('provider-2');
    expect(screen.getByTestId('model-selector').dataset.model).toBe('claude-opus-4-1');
    expect(screen.getByTestId('model-context').textContent).toBe('claude-opus-4-1');

    fireEvent.click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => {
      expect(updateProviderMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(ensureSessionMock).toHaveBeenCalled();
    });
  });

  it('persists reasoning effort even when the session has no provider binding', async () => {
    useAgentStore.setState({ isRunning: { 'session-running': false } });

    render(<AgentPanel sessionId="session-running" />);

    fireEvent.click(screen.getByRole('button', { name: 'change reasoning' }));

    await waitFor(() => {
      expect(updateReasoningEffortMock).toHaveBeenCalledWith('session-running', 'high');
    });
  });

});
