// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const startSessionMock = vi.fn<
  (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
  ) => Promise<void>
>();
const saveEventsMock = vi.fn<(sessionId: string, eventsJson: string) => Promise<void>>();
const getEventsMock = vi.fn<(sessionId: string) => Promise<string>>();
const loadClaudeSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
const loadCodexSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();

vi.mock('../lib/tauri', () => ({
  agentApi: {
    ensureSession: vi.fn(),
    sendInput: vi.fn(),
    startSession: startSessionMock,
    interrupt: vi.fn(),
    shutdown: vi.fn(),
    resetSession: vi.fn(),
    sendToolResponse: vi.fn(),
    deleteClaudeSessionFiles: vi.fn(),
    saveEvents: saveEventsMock,
    getEvents: getEventsMock,
    loadClaudeSessionEvents: loadClaudeSessionEventsMock,
    loadCodexSessionEvents: loadCodexSessionEventsMock,
    startProxy: vi.fn(),
    stopProxy: vi.fn(),
    getProxyPort: vi.fn(),
  },
  sessionApi: {
    create: vi.fn(),
    getAll: vi.fn(),
    delete: vi.fn(),
    updateTitle: vi.fn(),
    updateProvider: vi.fn(),
    getMessages: vi.fn(),
  },
  configApi: {
    get: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setActiveProvider: vi.fn(),
    setDefaultAgentKind: vi.fn(),
    updateAgentConfig: vi.fn(),
    setTheme: vi.fn(),
    fetchModels: vi.fn(),
    testProvider: vi.fn(),
  },
  fileApi: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    listDirectory: vi.fn(),
  },
  mcpApi: {
    getAll: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    probeAll: vi.fn(),
  },
  skillApi: {
    listInstalled: vi.fn(),
    uninstall: vi.fn(),
    toggle: vi.fn(),
    getContent: vi.fn(),
    syncBuiltins: vi.fn(),
    registerFromDisk: vi.fn(),
    getEnabledNames: vi.fn(),
  },
  appApi: {
    getLogDirectory: vi.fn(),
  },
}));

describe('agent store Codex history loading', () => {
  async function primeSession(agentKind: Session['agent_kind']) {
    const { useAgentStore } = await import('./agentStore');
    const { useSessionStore } = await import('./sessionStore');

    const session: Session = {
      id: `session-${agentKind}-1`,
      title: `${agentKind} History`,
      agent_kind: agentKind,
      provider_id: null,
      model: 'o4-mini',
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };

    useSessionStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      isLoading: false,
      error: null,
    });

    useAgentStore.setState({
      events: {},
      eventTimestamps: {},
      isRunning: {},
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

    return session;
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    startSessionMock.mockImplementation(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Codex reply' }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        total_cost_usd: 0,
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
      onEvent(JSON.stringify({ type: 'sidecar_query_done' }));
    });

    saveEventsMock.mockResolvedValue();
    getEventsMock.mockResolvedValue(JSON.stringify({
      events: [
        { kind: 'user', data: { content: 'stale sqlite event' } },
      ],
      timestamps: [1],
    }));
    loadClaudeSessionEventsMock.mockResolvedValue([]);
    loadCodexSessionEventsMock.mockResolvedValue([]);

    localStorage.clear();
  });

  it.each(['codex', 'claude_code'] as const)('does not persist %s history snapshots into SQLite', async (agentKind) => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession(agentKind);

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(saveEventsMock).not.toHaveBeenCalled();
  });

  it('stops running after a successful result even if sidecar_query_done never arrives', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Codex reply' }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        total_cost_usd: 0,
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
  });

  it.each([
    ['codex', loadCodexSessionEventsMock],
    ['claude_code', loadClaudeSessionEventsMock],
  ] as const)('does not fall back to SQLite when %s JSONL history is unavailable', async (agentKind, loaderMock) => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession(agentKind);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(loaderMock).toHaveBeenCalledWith(session.id);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().events[session.id]).toBeUndefined();
  });
});
