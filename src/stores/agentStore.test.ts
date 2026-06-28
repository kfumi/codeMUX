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
      { text: 'TEMPLATE: review current changes' },
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

  it('throttles streaming thinking flushes instead of updating on every animation frame', async () => {
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

      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');

      await vi.advanceTimersByTimeAsync(50);
      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');

      await vi.advanceTimersByTimeAsync(70);
      expect(useAgentStore.getState().streamingThinking[session.id]).toBe(
        'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;',
      );
    } finally {
      requestAnimationFrameMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('throttles simulated streaming text instead of updating visible state for every chunk', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-simulated-stream',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'simulated-stream-text'.repeat(80) }],
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

      await vi.advanceTimersByTimeAsync(80);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toBe('');

      await vi.advanceTimersByTimeAsync(80);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toContain('simulated-stream-text');

      await vi.advanceTimersByTimeAsync(1_000);
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
        total_cost_usd: 0,
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

  it('sends image payloads for unknown models by default', async () => {
    const { useAgentStore } = await import('./agentStore');
    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, 'future-model-7', undefined, undefined, undefined, inputPayload);

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      undefined,
      'future-model-7',
      undefined,
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
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, model, undefined, undefined, undefined, inputPayload);

    expect(startSessionMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      'D:\\project\\ai-code\\codeMUX',
      expect.any(Function),
      undefined,
      undefined,
      model,
      undefined,
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
