// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';
import type { AgentUserMessageLocator } from '../types/agent';

const startSessionMock = vi.fn<
  (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    reasoningEffort?: string,
    inputPayload?: { text: string },
  ) => Promise<void>
>();
const saveEventsMock = vi.fn<(sessionId: string, eventsJson: string) => Promise<void>>();
const getEventsMock = vi.fn<(sessionId: string) => Promise<string>>();
const loadClaudeSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
const loadCodexSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
const loadLatestTokenUsageMock = vi.fn<(appSessionId: string, agentKind: string, freshness: 'live_synced' | 'restored') => Promise<Record<string, unknown> | null>>();
const rewindSessionMock = vi.fn<(appSessionId: string, agentKind: string, target?: AgentUserMessageLocator) => Promise<void>>();

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
    loadLatestTokenUsage: loadLatestTokenUsageMock,
    rewindSession: rewindSessionMock,
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
    touch: vi.fn(() => Promise.resolve()),
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
  gitApi: {},
  mcpApi: {
    getAll: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    probeAll: vi.fn(),
  },
  skillApi: {
    listInstalled: vi.fn(),
    listImportable: vi.fn(),
    uninstall: vi.fn(),
    toggleApp: vi.fn(),
    getContent: vi.fn(),
    syncBuiltins: vi.fn(),
    registerFromDisk: vi.fn(),
    importFromApps: vi.fn(),
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
      tokenUsageBySession: {},
      tokenUsageRefreshRequests: {},
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
    loadLatestTokenUsageMock.mockResolvedValue(null);
    rewindSessionMock.mockResolvedValue();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('refreshes Claude Code token usage from history after a successful result and ignores result usage', async () => {
    loadLatestTokenUsageMock.mockResolvedValueOnce({
      total: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-live-usage',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 999_999,
          output_tokens: 25,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    await vi.waitFor(() => {
      expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'live_synced');
    });
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
  });

  it('does not refresh token usage for failed results', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        uuid: 'failed-result',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: 'failed',
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(loadLatestTokenUsageMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toBeUndefined();
  });

  it('ignores legacy sidecar token_usage_update events without appending a message', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'token_usage_update',
        session_id: sessionId,
        token_usage: {
          total: { totalTokens: 55_074, inputTokens: 21_700, cachedInputTokens: 32_800, outputTokens: 574 },
          last: { totalTokens: 55_074, inputTokens: 21_700, cachedInputTokens: 32_800, outputTokens: 574 },
          modelContextWindow: 258_400,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id].map((event) => event.kind)).toEqual([
      'user',
    ]);
    expect(loadLatestTokenUsageMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toBeUndefined();
  });

  it('keeps existing token usage while syncing and ignores stale refresh responses', async () => {
    let resolveFirst: (value: Record<string, unknown> | null) => void = () => {};
    let resolveSecond: (value: Record<string, unknown> | null) => void = () => {};
    loadLatestTokenUsageMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');
    useAgentStore.getState().setSessionTokenUsage(session.id, {
      total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    const first = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');
    const second = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');

    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: { totalTokens: 100 },
      contextUsageFreshness: 'syncing',
    });

    resolveSecond({
      total: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    await second;

    resolveFirst({
      total: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
      last: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    await first;

    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: { totalTokens: 200 },
      contextUsageFreshness: 'live_synced',
    });
  });

  it('removes reconnecting stream status after a successful Codex result', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'sidecar_stream_status',
        message: 'Reconnecting... 5/5 (stream disconnected before completion: stream closed before response.completed)',
        is_reconnecting: true,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered reply' }],
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

    expect(useAgentStore.getState().events[session.id].some((event) => event.kind === 'stream_status')).toBe(false);
  });

  it('preserves Codex mode-blocked stream diagnostics', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'sidecar_stream_status',
        message: 'Codex collaboration mode blocked item/tool/requestUserInput: request_user_input_blocked_in_default_mode.',
        is_reconnecting: false,
        mode_blocked: {
          blocked_method: 'item/tool/requestUserInput',
          effective_mode: 'code',
          reason_code: 'request_user_input_blocked_in_default_mode',
          reason: 'requestUserInput is blocked while effective_mode=code',
          suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
          request_id: 'tool-1',
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stream_status',
          data: expect.objectContaining({
            mode_blocked: expect.objectContaining({
              reason_code: 'request_user_input_blocked_in_default_mode',
            }),
          }),
        }),
      ]),
    );
  });

  it('keeps the first file snapshot as the diff baseline across repeated edits', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      const filePath = 'D:\\project\\ai-code\\codeMUX\\src\\example.ts';

      onEvent(JSON.stringify({
        type: 'file_snapshot',
        file_path: filePath,
        original_content: 'alpha\nbeta\ngamma\n',
        is_new: false,
        tool_use_id: 'tool-1',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-edit-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: 'alpha',
              new_string: 'ALPHA',
            },
          }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'file_snapshot',
        file_path: filePath,
        original_content: 'ALPHA\nbeta\ngamma\n',
        is_new: false,
        tool_use_id: 'tool-2',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-edit-2',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-2',
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: 'gamma',
              new_string: 'GAMMA',
            },
          }],
        },
      }));
      onEvent(JSON.stringify({ type: 'sidecar_query_done' }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Edit the same file twice', 'D:\\project\\ai-code\\codeMUX');

    const [changedFile] = useAgentStore.getState().changedFiles[session.id];
    expect(changedFile.originalContent).toBe('alpha\nbeta\ngamma\n');
    expect(changedFile.currentContent).toBe('ALPHA\nbeta\nGAMMA\n');
    expect(changedFile.additions).toBe(2);
    expect(changedFile.deletions).toBe(2);
  });

  it('does not expose unused git baseline state', async () => {
    const { useAgentStore } = await import('./agentStore');

    expect(useAgentStore.getState()).not.toHaveProperty('gitBaselines');
  });

  it('commits pending simulated assistant text before the result event', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    const kinds = useAgentStore.getState().events[session.id]?.map((event) => event.kind) ?? [];
    expect(kinds.indexOf('assistant')).toBeLessThan(kinds.indexOf('result'));
  });

  it('can send a runtime prompt while showing separate user-facing content', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'TEMPLATE: review current changes', 'D:\\project\\ai-code\\codeMUX', undefined, '/review');

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'TEMPLATE: review current changes',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      { text: 'TEMPLATE: review current changes' },
    );
    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: { content: '/review' },
    });
  });

  it('treats isMeta user events from the live stream as raw, not as user turns', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'expanded slash command prompt' },
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, '/review', 'D:\\project\\ai-code\\codeMUX', undefined, undefined, undefined, undefined, undefined, '/review');

    const events = useAgentStore.getState().events[session.id] ?? [];
    const userEvents = events.filter((event) => event.kind === 'user');
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toEqual({ kind: 'user', data: { content: '/review' } });
  });

  it('restores Codex task progress from persisted update_plan calls', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        timestamp: '2026-06-21T08:00:01.174Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call-plan-1',
            name: 'update_plan',
            input: {
              explanation: 'all done',
              plan: [
                { status: 'completed', step: 'Task 1' },
                { status: 'completed', step: 'Task 2' },
                { status: 'completed', step: 'Task 3' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed', activeForm: undefined },
      { content: 'Task 2', status: 'completed', activeForm: undefined },
      { content: 'Task 3', status: 'completed', activeForm: undefined },
    ]);
  });

  it('lets live Codex update_plan completion override an earlier todo list state', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'todo-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'todo-list-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed' },
                { content: 'Task 2', status: 'completed' },
                { content: 'Task 3', status: 'in_progress' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'plan-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call-plan-1',
            name: 'update_plan',
            input: {
              plan: [
                { status: 'completed', step: 'Task 1' },
                { status: 'completed', step: 'Task 2' },
                { status: 'completed', step: 'Task 3' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
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
      .startQuery(session.id, 'continue', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed', activeForm: undefined },
      { content: 'Task 2', status: 'completed', activeForm: undefined },
      { content: 'Task 3', status: 'completed', activeForm: undefined },
    ]);
  });

  it('updates task progress from Codex todo state events without adding chat messages', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'codex_todo_list',
        session_id: sessionId,
        todos: [
          { content: 'Task 1', status: 'completed' },
          { content: 'Task 2', status: 'pending' },
        ],
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
      .startQuery(session.id, 'continue', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed' },
      { content: 'Task 2', status: 'pending' },
    ]);
    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'continue' } },
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('applies leading-edge streaming thinking and coalesces later deltas', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameMock = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => clearTimeout(handle));

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }));

      for (let index = 0; index < 5; index += 1) {
        onEvent(JSON.stringify({
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: `chunk-${index};` },
          },
        }));
      }
    });

    try {
      const { useAgentStore } = await import('./agentStore');
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream thinking', 'D:\\project\\ai-code\\codeMUX');

      // Leading edge: first delta is visible immediately.
      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('chunk-0;');

      await vi.advanceTimersByTimeAsync(40);
      expect(useAgentStore.getState().streamingThinking[session.id]).toBe(
        'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;',
      );
      expect('streamingThinkingDurations' in useAgentStore.getState()).toBe(false);
    } finally {
      requestAnimationFrameMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('throttles simulated streaming text instead of updating visible state for every chunk', async () => {
    vi.useFakeTimers();
    const simulatedText = 'simulated-stream-text '.repeat(40);

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-simulated-stream',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: simulatedText }],
        },
        parent_tool_use_id: null,
      }));
    });

    try {
      const { useAgentStore } = await import('./agentStore');
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'simulate stream', 'D:\\project\\ai-code\\codeMUX');

      // Leading-edge flush: first sim tick paints immediately after the 30ms start delay.
      await vi.advanceTimersByTimeAsync(40);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toContain('simulated-stream-text');
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeLessThan(simulatedText.length);

      await vi.advanceTimersByTimeAsync(80);
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeGreaterThan(0);
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeLessThan(simulatedText.length);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toBe('');
      expect(useAgentStore.getState().events[session.id]).toContainEqual(
        expect.objectContaining({ kind: 'assistant' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers streaming tool input deltas without notifying the store for every partial json chunk', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        },
      }));

      for (let index = 0; index < 10; index += 1) {
        onEvent(JSON.stringify({
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: index === 0 ? '{"command":"' : `part-${index}` },
          },
        }));
      }
    });

    try {
      const { useAgentStore } = await import('./agentStore');
      const session = await primeSession('codex');
      let toolInputNotifications = 0;
      const unsubscribe = useAgentStore.subscribe((state, previousState) => {
        if (state.streamingToolInputs !== previousState.streamingToolInputs) {
          toolInputNotifications += 1;
        }
      });

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream tool args', 'D:\\project\\ai-code\\codeMUX');

      unsubscribe();
      expect(toolInputNotifications).toBe(1);
      expect(useAgentStore.getState().streamingToolInputs[session.id]?.['tool-1']).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a live streamed tool placeholder with the complete assistant tool call', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"command":"powershell.exe -Command Get-Content src\\\\stores\\\\agentStore.ts"}',
          },
        },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-complete-tool',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell_command',
            input: {
              command: 'Get-Content src\\stores\\agentStore.ts',
              timeout_ms: 10000,
              workdir: 'D:\\project\\ai-code\\codeMUX',
            },
          }],
        },
        parent_tool_use_id: null,
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'inspect store', 'D:\\project\\ai-code\\codeMUX');

    const toolBlocks = (useAgentStore.getState().events[session.id] ?? [])
      .filter((event) => event.kind === 'assistant')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'tool_use' && block.id === 'tool-1');

    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'tool-1',
      name: 'shell_command',
      input: {
        command: 'Get-Content src\\stores\\agentStore.ts',
        timeout_ms: 10000,
        workdir: 'D:\\project\\ai-code\\codeMUX',
      },
    });
  });

  it('keeps a complete assistant tool call when a streamed id exists without a replaceable tool block', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      const { useAgentStore } = await import('./agentStore');
      useAgentStore.setState((state) => ({
        streamedToolUseIds: {
          ...state.streamedToolUseIds,
          [sessionId]: new Set(['tool-race']),
        },
      }));

      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-complete-tool-race',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-race',
            name: 'shell_command',
            input: {
              command: 'rg --files',
              workdir: 'D:\\project\\ai-code\\codeMUX',
            },
          }],
        },
        parent_tool_use_id: null,
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'inspect files', 'D:\\project\\ai-code\\codeMUX');

    const toolBlocks = (useAgentStore.getState().events[session.id] ?? [])
      .filter((event) => event.kind === 'assistant')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'tool_use' && block.id === 'tool-race');

    expect(toolBlocks).toEqual([{
      type: 'tool_use',
      id: 'tool-race',
      name: 'shell_command',
      input: {
        command: 'rg --files',
        workdir: 'D:\\project\\ai-code\\codeMUX',
      },
    }]);
  });

  it('drops sidecar debug events instead of appending them to the conversation event list', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      for (let index = 0; index < 20; index += 1) {
        onEvent(JSON.stringify({
          type: 'sidecar_debug',
          message: `[debug] noisy stream log ${index}`,
        }));
      }

      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-debug',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'debug noise', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'debug noise' } },
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('drops live Claude compact summary user events while keeping the compact marker', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            'This session is being continued from a previous conversation that ran out of context.',
            'The summary below covers the earlier portion of the conversation.',
            '',
            'Summary:',
          ].join('\n'),
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 34000,
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-compact-live',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, '/compact', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      expect.objectContaining({ kind: 'user', data: expect.objectContaining({ content: '/compact' }) }),
      expect.objectContaining({ kind: 'compact' }),
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('maps live raw Codex compacted events to compact markers', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'compacted',
        timestamp: '2026-07-03T17:22:53.471Z',
        payload: {
          trigger: 'auto',
          pre_tokens: 42000,
          post_tokens: 3000,
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-compact-live',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'trigger compact', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'trigger compact' } },
      expect.objectContaining({
        kind: 'compact',
        data: expect.objectContaining({
          compact_metadata: expect.objectContaining({
            trigger: 'auto',
            pre_tokens: 42000,
          }),
        }),
      }),
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('processes batched stream events without appending the batch to the conversation event list', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event_batch',
        session_id: sessionId,
        events: [
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
        ],
      }));
    });

    try {
      const { useAgentStore } = await import('./agentStore');
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'batched stream', 'D:\\project\\ai-code\\codeMUX');

      await vi.advanceTimersByTimeAsync(120);

      expect(useAgentStore.getState().streamingText[session.id]).toBe('hello world');
      expect(useAgentStore.getState().events[session.id]).toEqual([
        { kind: 'user', data: { content: 'batched stream' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces live Codex text streaming with the final assistant event without duplicate visible text', async () => {
    vi.useFakeTimers();

    let capturedOnEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'final streamed answer' } },
      }));
    });

    try {
      const { useAgentStore } = await import('./agentStore');
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream then final', 'D:\\project\\ai-code\\codeMUX');

      await vi.advanceTimersByTimeAsync(120);
      expect(useAgentStore.getState().streamingText[session.id]).toBe('final streamed answer');

      capturedOnEvent?.(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-final',
        session_id: session.id,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final streamed answer' }],
        },
      }));

      expect(useAgentStore.getState().streamingText[session.id]).toBe('');
      expect(useAgentStore.getState().events[session.id]).toEqual([
        { kind: 'user', data: { content: 'stream then final' } },
        expect.objectContaining({ kind: 'assistant' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
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

  it('loads Codex history CodeMUX tool and outcome events through the live adapter', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'tool_started',
        session_id: session.id,
        tool_use_id: 'call-read',
        name: 'read_file',
        input: { path: 'README.md' },
        timestamp: '2026-07-10T12:00:01.000Z',
        event_id: 'history-event-1',
        sequence: 0,
      },
      {
        type: 'tool_finished',
        session_id: session.id,
        tool_use_id: 'call-read',
        content: '内容',
        is_error: false,
        timestamp: '2026-07-10T12:00:02.000Z',
        event_id: 'history-event-2',
        sequence: 1,
      },
      {
        type: 'turn_finished',
        session_id: session.id,
        outcome: 'completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        timestamp: '2026-07-10T12:00:03.000Z',
        event_id: 'history-event-3',
        sequence: 2,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        data: expect.objectContaining({ uuid: 'history-event-1' }),
      }),
      expect.objectContaining({
        kind: 'tool_result',
        data: expect.objectContaining({ uuid: 'history-event-2' }),
      }),
      expect.objectContaining({
        kind: 'result',
        data: expect.objectContaining({ subtype: 'success', uuid: 'history-event-3' }),
      }),
    ]);
  });

  it('refreshes Claude Code token usage from history after loading historical messages', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');
    loadLatestTokenUsageMock.mockResolvedValueOnce({
      total: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    loadClaudeSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user',
        timestamp: '2026-07-10T12:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-10T12:00:03.000Z',
        uuid: 'assistant-historical',
        session_id: session.id,
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'reply' }],
          usage: {
            input_tokens: 200,
            output_tokens: 40,
            cache_read_input_tokens: 60,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'result' }),
      ]),
    );
    expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'restored');
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      total: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
      },
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });
  });

  it('loads historical Claude Agent tool calls without subagent linkage and filters sidechain history', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    loadClaudeSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        uuid: 'assistant-agent',
        session_id: session.id,
        timestamp: '2026-06-29T15:34:22.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_22bf1cc2e7484a108461feb0',
              name: 'Agent',
              input: { description: 'Read package.json', prompt: 'Read the file' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'sidechain-assistant',
        session_id: session.id,
        isSidechain: true,
        timestamp: '2026-06-29T15:34:25.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent transcript should not be in main history' }],
        },
        parent_tool_use_id: null,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events).toHaveLength(1);
    const block = events[0]?.kind === 'assistant' ? events[0].data.message.content[0] : undefined;
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'call_22bf1cc2e7484a108461feb0',
      name: 'Agent',
    });
    expect(block).not.toHaveProperty('agentId');
    expect(block).not.toHaveProperty('subAgentKey');
  });

  it('filters live Claude subagent stream events from the main event list', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-agent-live',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_live_agent',
              name: 'Agent',
              input: { description: 'Explore', prompt: 'inspect' },
            },
          ],
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-subagent-live',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'package.json' } }],
        },
        parent_tool_use_id: 'call_live_agent',
      }));
      onEvent(JSON.stringify({
        type: 'user',
        uuid: 'tool-result-subagent-live',
        session_id: sessionId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'package contents' }],
        },
        parent_tool_use_id: 'call_live_agent',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-subagent-summary-live',
        session_id: sessionId,
        isSidechain: true,
        parentUuid: 'tool-result-subagent-live',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here are the requested values from package.json.' }],
        },
      }));
    });

    await useAgentStore.getState().startQuery(session.id, 'run agent', 'D:\\project\\ai-code\\codeMUX');
    await Promise.resolve();

    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.kind === 'assistant' && event.data.uuid === 'assistant-subagent-live')).toBe(false);
    expect(events.some((event) => event.kind === 'tool_result' && event.data.uuid === 'tool-result-subagent-live')).toBe(false);
    const block = events.find((event) => event.kind === 'assistant')?.kind === 'assistant'
      ? (events.find((event) => event.kind === 'assistant') as Extract<(typeof events)[number], { kind: 'assistant' }>).data.message.content[0]
      : undefined;
    expect(block).not.toHaveProperty('agentId');
    expect(block).not.toHaveProperty('subAgentKey');
  });

  it('sends image payloads for unknown models by default', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, inputPayload, 'future-model-7');

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      inputPayload,
    );
  });

  it.each([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'mimo-v2.5-pro',
  ])('drops image payloads for explicit no-vision model %s but keeps local preview', async (model) => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, inputPayload, model);

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      { text: 'inspect this' },
    );
    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: {
        content: 'inspect this',
        attachments: [{ type: 'image', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      },
    });
  });

  it('restores image previews directly from agent JSONL image blocks', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');
    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user',
        timestamp: '2026-06-28T12:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc',
              },
            },
          ],
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: {
        content: 'inspect this',
        attachments: [{ type: 'image', name: 'image-1.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      },
    });
  });

  it('rewinds the last turn, clears derived state, and returns text plus image payload', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'user',
            data: {
              content: 'inspect image',
              attachments: [{ type: 'image', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
              locator: {
                providerMessageId: 'codex-user-2',
                lineIndex: 12,
                role: 'user',
                textFingerprint: 'inspect image',
                turnOrdinal: 2,
              },
            },
          },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-2',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-2',
              session_id: session.id,
              duration_ms: 10,
              duration_api_ms: 10,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3, 4, 5] },
      todos: { [session.id]: [{ content: 'old todo', status: 'pending' }] },
      streamingThinking: { [session.id]: 'thinking' },
      streamingText: { [session.id]: 'streaming' },
      changedFiles: { [session.id]: [{ path: 'src/app.ts', status: 'modified', originalContent: 'old', currentContent: 'new', additions: 1, deletions: 1 }] },
    });

    const payload = await useAgentStore.getState().rewindLastTurn(session.id);

    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'codex', {
      providerMessageId: 'codex-user-2',
      lineIndex: 12,
      role: 'user',
      textFingerprint: 'inspect image',
      turnOrdinal: 2,
    });
    expect(payload).toEqual({
      text: 'inspect image',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    });
    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'first turn' } },
      expect.objectContaining({ kind: 'assistant' }),
    ]);
    expect(useAgentStore.getState().eventTimestamps[session.id]).toEqual([1, 2]);
    expect(useAgentStore.getState().todos[session.id]).toBeUndefined();
    expect(useAgentStore.getState().streamingThinking[session.id]).toBe('');
    expect(useAgentStore.getState().streamingText[session.id]).toBe('');
    expect(useAgentStore.getState().changedFiles[session.id]).toBeUndefined();
  });

  it('rewinds optimistic live user messages without sending a weak target', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('claude_code');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'live prompt' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-live',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [100, 200] },
    });

    await useAgentStore.getState().rewindLastTurn(session.id);

    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'claude_code', undefined);
  });

  it('marks an inactive session unread after a rewound turn completes', async () => {
    const { useAgentStore } = await import('./agentStore');
    const { useSessionStore } = await import('./sessionStore');
    const session = await primeSession('codex');

    useSessionStore.setState({ activeSessionId: 'other-session', unreadSessions: new Set() });
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'old prompt' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-old',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-old',
              session_id: session.id,
              duration_ms: 10,
              duration_api_ms: 10,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1000, 2000, 3000] },
    });

    await useAgentStore.getState().rewindLastTurn(session.id);
    await useAgentStore.getState().startQuery(session.id, 'edited prompt', 'D:\\project\\ai-code\\codeMUX');

    expect(useSessionStore.getState().unreadSessions.has(session.id)).toBe(true);
  });

  it('does not restore acknowledged changed-file state while loading history', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    localStorage.setItem(`acknowledged-files-${session.id}`, JSON.stringify(['src/old.ts']));
    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        timestamp: '2026-06-18T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'history' }],
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().acknowledgedFiles[session.id]).toBeUndefined();
  });
});
