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
const getChangedFilesSinceHeadMock = vi.fn();

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
  gitApi: {
    getChangedFilesSinceHead: getChangedFilesSinceHeadMock,
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
      gitBaselines: {},
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

  it('does not scan git changes after terminal events', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Change a file with apply_patch', 'D:\\project\\ai-code\\codeMUX');

    expect(getChangedFilesSinceHeadMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
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
      .startQuery(session.id, 'TEMPLATE: review current changes', 'D:\\project\\ai-code\\codeMUX', undefined, undefined, undefined, undefined, undefined, '/review');

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'TEMPLATE: review current changes',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: { content: '/review' },
    });
  });

  it('restores Codex command prompt templates as user-facing slash directives', async () => {
    const { useAgentStore } = await import('./agentStore');
    const { findCommand, renderCommandPrompt } = await import('../lib/slashCommands');
    const session = await primeSession('codex');
    const plan = findCommand('plan', 'codex')!;

    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user',
        timestamp: '2026-06-20T10:00:00.000Z',
        message: {
          role: 'user',
          content: renderCommandPrompt(plan, 'add login flow'),
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: { content: '/plan add login flow' },
    });
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
