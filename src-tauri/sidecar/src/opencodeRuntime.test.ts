import { describe, expect, it, vi } from 'vitest';
import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import {
  officialOpenCodeSdkPort,
  type OpenCodeSdkPort,
  type OpenCodeSdkStartFailure,
} from './opencodeSdk.js';

const sdkMocks = vi.hoisted(() => {
  const prompt = vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } });
  const promptAsync = vi.fn().mockResolvedValue({ data: {} });
  const session = {
    create: vi.fn().mockResolvedValue({ data: { id: 'mock-session' } }),
    get: vi.fn().mockResolvedValue({ data: { id: 'mock-session' } }),
    fork: vi.fn().mockResolvedValue({ data: { id: 'mock-forked-session' } }),
    delete: vi.fn().mockResolvedValue({ data: true }),
    prompt,
    promptAsync,
    abort: vi.fn().mockResolvedValue({ data: true }),
  };
  const client = { session };
  const createClient = vi.fn().mockReturnValue(client);
  const createServer = vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:4097',
    close: vi.fn().mockResolvedValue(undefined),
  });
  const runtimeRef = {
    provider: 'opencode',
    runtimeRoot: 'D:/runtimes',
    runtimePath: 'D:/runtimes/opencode/1.18.3',
    runtimeVersion: '1.18.3',
  };
  const runtimeLoaded = {
    ref: runtimeRef,
    nodeModulesPath: 'D:/runtimes/opencode/1.18.3/node_modules',
    runtimeRequire: vi.fn((packageName: string) => {
      if (packageName === '@opencode-ai/sdk/client') return { createOpencodeClient: createClient };
      if (packageName === '@opencode-ai/sdk/server') return { createOpencodeServer: createServer };
      throw new Error(`unexpected runtime package: ${packageName}`);
    }),
  };
  return { prompt, promptAsync, createClient, createServer, client, runtimeRef, runtimeLoaded };
});

vi.mock('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: sdkMocks.createClient,
}));
vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: sdkMocks.createServer,
}));
vi.mock('./runtimeLoader.js', () => ({
  loadProviderRuntime: vi.fn().mockReturnValue(sdkMocks.runtimeLoaded),
  isRuntimeError: vi.fn().mockReturnValue(false),
}));
vi.mock('./opencodeExecutable.js', () => ({
  prepareOpenCodeExecutable: vi.fn(),
}));

function createConfig(overrides: Partial<OpenCodeSessionConfig> = {}): OpenCodeSessionConfig {
  return {
    cwd: 'D:/workspace/demo',
    sessionId: 'codemux-session-1',
    runtimeGeneration: 1,
    provider: 'codemux-openai',
    model: 'gpt-5',
    credentialSource: 'codemux',
    apiKey: 'secret-key',
    baseUrl: 'https://provider.example/v1',
    runtimeRef: sdkMocks.runtimeRef,
    ...overrides,
  };
}

function createPort() {
  const server = { close: vi.fn() };
  const client = {
    createSession: vi.fn().mockResolvedValue({ id: 'opencode-new' }),
    restoreSession: vi.fn().mockResolvedValue({ id: 'opencode-existing' }),
    forkSession: vi.fn().mockResolvedValue({ id: 'opencode-forked' }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    respondToPermission: vi.fn().mockResolvedValue(true),
    setAutoApprovePermissions: vi.fn().mockResolvedValue(undefined),
  };
  const port: OpenCodeSdkPort = {
    start: vi.fn().mockResolvedValue({ server, client }),
  };
  return { port, server, client };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('OpenCodeRuntime', () => {
  it('reuses a started runtime across lifecycle generation updates', async () => {
    const { port } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);

    await runtime.start();

    expect(runtime.canReuse(createConfig({
      agentSessionId: 'opencode-new',
      runtimeGeneration: 2,
    }))).toBe(true);
    expect(runtime.canReuse(createConfig({
      agentSessionId: 'opencode-new',
      model: 'gpt-5-mini',
      runtimeGeneration: 2,
    }))).toBe(false);

    await runtime.shutdown();
  });

  it('ignores OpenCode heartbeat events without emitting diagnostics or logs', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      emitEvent: (event) => emitted.push(event),
    });

    await runtime.start();
    const stderr = (globalThis as unknown as {
      process: { stderr: { write: (...args: unknown[]) => boolean } };
    }).process.stderr;
    const stderrWrite = vi.spyOn(stderr, 'write').mockImplementation(() => true);
    try {
      onEvent({ type: 'server.heartbeat', properties: {} });

      expect(emitted).toEqual([]);
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      await runtime.shutdown();
    }
  });

  it('merges partial compatibility permission updates without changing omitted fields', () => {
    const { port } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);

    runtime.updatePermissions({ permissionConfig: { kind: 'codex', approvalPolicy: 'never' }, planMode: 'on' });
    runtime.updatePermissions({ planMode: 'off' });

    expect((runtime as unknown as { permissionConfig: unknown }).permissionConfig).toEqual({ kind: 'codex', approvalPolicy: 'never' });
    expect((runtime as unknown as { planMode: string }).planMode).toBe('off');
  });

  it('pushes the OpenCode auto-approve shield toggle through the client', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);

    // Updates arriving before start() are deferred until the client exists.
    runtime.updatePermissions({
      permissionConfig: { kind: 'opencode', autoApprovePermissions: true },
      planMode: 'off',
    });
    expect(client.setAutoApprovePermissions).not.toHaveBeenCalled();

    await runtime.start();
    await flushAsync();
    expect(client.setAutoApprovePermissions).toHaveBeenCalledWith({ enable: true });

    runtime.updatePermissions({ permissionConfig: { kind: 'opencode', autoApprovePermissions: false } });
    await flushAsync();
    expect(client.setAutoApprovePermissions).toHaveBeenLastCalledWith({ enable: false });

    // Unchanged state is not pushed again.
    runtime.updatePermissions({ planMode: 'on' });
    await flushAsync();
    expect(client.setAutoApprovePermissions).toHaveBeenCalledTimes(2);
  });

  it('does not push auto-approve for non-OpenCode configs and retries after failures', async () => {
    const { port, client } = createPort();
    client.setAutoApprovePermissions = vi.fn()
      .mockRejectedValueOnce(new Error('server unreachable'))
      .mockResolvedValueOnce(undefined);
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    runtime.updatePermissions({ permissionConfig: { kind: 'claude_code', permissionMode: 'default' } });
    await flushAsync();
    expect(client.setAutoApprovePermissions).not.toHaveBeenCalled();

    runtime.updatePermissions({ permissionConfig: { kind: 'opencode', autoApprovePermissions: true } });
    await flushAsync();
    expect(client.setAutoApprovePermissions).toHaveBeenCalledTimes(1);

    // The failed enable is retried by the next lifecycle update.
    runtime.updatePermissions({ planMode: 'on' });
    await flushAsync();
    expect(client.setAutoApprovePermissions).toHaveBeenCalledTimes(2);
    expect(client.setAutoApprovePermissions).toHaveBeenLastCalledWith({ enable: true });
  });

  it('emits a CodeMUX lifecycle around an OpenCode user question', async () => {
    const { port, client } = createPort();
    Object.assign(client, { respondToQuestion: vi.fn().mockResolvedValue(true) });
    const emitted: Array<Record<string, unknown>> = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      emitEvent: (event) => emitted.push(event as Record<string, unknown>),
      eventIdFactory: () => 'event-1',
    });

    await runtime.start();
    onEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        sessionID: 'opencode-new',
        questions: [{ question: '继续吗？', multiple: true, options: [{ label: '继续' }] }],
      },
    });
    await runtime.respondToQuestion('question-1', [['继续']]);

    expect(emitted).toMatchObject([
      {
        type: 'tool_started', tool_use_id: 'question-1', name: 'request_user_input', sequence: 0,
      },
      {
        type: 'user_input_requested',
        tool_use_id: 'question-1',
        sequence: 1,
        questions: [{ question: '继续吗？', multiSelect: true }],
      },
      {
        type: 'tool_finished', tool_use_id: 'question-1', content: '{"answers":[["继续"]]}', sequence: 2,
      },
    ]);
    await runtime.shutdown();
  });

  it('finishes OpenCode subtasks before the terminal outcome', async () => {
    const { port, client } = createPort();
    const emitted: Array<Record<string, unknown>> = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      emitEvent: (event) => emitted.push(event as Record<string, unknown>),
      eventIdFactory: () => 'event-1',
    });

    await runtime.start();
    onEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-new',
        part: {
          id: 'task-1', messageID: 'message-1', type: 'subtask',
          prompt: '检查测试', description: '检查测试', agent: 'explore',
        },
      },
    });
    onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });

    expect(emitted.map((event) => event.type)).toEqual(['tool_started', 'tool_finished', 'turn_finished']);
    expect(emitted.map((event) => event.sequence)).toEqual([0, 1, 2]);
    await runtime.shutdown();
  });

  it('aborts and emits a terminal timeout error when no progress events arrive before the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      client.subscribe = vi.fn().mockResolvedValue({ close: vi.fn() });
      const emitted: unknown[] = [];
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25 } }), port, {
        emitEvent: (event) => emitted.push(event),
        eventIdFactory: () => 'event-timeout',
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('hello');
      await vi.advanceTimersByTimeAsync(25);
      await sendPromise;

      expect(client.abort).toHaveBeenCalledWith('opencode-new');
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'error', subtype: 'timeout' }),
        expect.objectContaining({ type: 'turn_finished', outcome: 'failed' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });
  it('promotes a child free-tier failure to the active parent turn', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      let onEvent: (event: unknown) => void = () => undefined;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const emitted: Array<Record<string, unknown>> = [];
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25 } }), port, {
        emitEvent: (event) => emitted.push(event as Record<string, unknown>),
        eventIdFactory: () => 'event-provider-quota',
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('delegate research');
      onEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'opencode-new',
          part: {
            type: 'tool',
            tool: 'Task',
            callID: 'task-1',
            state: {
              status: 'running',
              input: {},
              metadata: { parentSessionId: 'opencode-new', sessionId: 'child-session-1' },
            },
          },
        },
      });
      onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });
      onEvent({
        type: 'session.status',
        properties: {
          sessionID: 'child-session-1',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Free usage exceeded, subscribe to Go',
            action: { reason: 'free_tier_limit' },
          },
        },
      });
      await Promise.resolve();

      try {
        expect(client.abort).toHaveBeenCalledWith('opencode-new');
        expect(emitted).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_finished',
            tool_use_id: 'task-1',
            is_error: true,
            content: expect.stringContaining('Free usage exceeded'),
          }),
          expect.objectContaining({
            type: 'error',
            subtype: 'provider_quota',
            error: expect.stringContaining('Free usage exceeded'),
          }),
          expect.objectContaining({ type: 'turn_finished', outcome: 'failed' }),
        ]));
        expect(emitted).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        ]));
      } finally {
        onEvent({ type: 'session.interrupted', properties: { sessionID: 'opencode-new' } });
        await sendPromise;
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('re-arms the idle guard after progress events in the active session', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      let onEvent: (event: unknown) => void = () => undefined;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25 } }), port, {
        emitEvent: (event) => undefined,
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('keep streaming');
      await vi.advanceTimersByTimeAsync(20);
      onEvent({
        type: 'session.status',
        properties: { sessionID: 'opencode-new', status: { type: 'busy' } },
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(client.abort).not.toHaveBeenCalled();
      onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });
      await sendPromise;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not expire the turn while a permission is awaiting approval', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      client.respondToPermission.mockResolvedValue(true);
      let onEvent: (event: unknown) => void = () => undefined;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const emitted: unknown[] = [];
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25, approval_timeout_ms: 0 } }), port, {
        emitEvent: (event) => emitted.push(event),
        eventIdFactory: () => 'event-id',
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('hello');
      onEvent({
        type: 'permission.asked',
        properties: { id: 'perm-1', sessionID: 'opencode-new', type: 'write', title: 'edit file' },
      });

      await vi.advanceTimersByTimeAsync(2000);
      expect(client.abort).not.toHaveBeenCalled();
      expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(false);

      onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });
      await sendPromise;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not expire the turn while a tool is running, then re-arms the guard when it finishes', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      let onEvent: (event: unknown) => void = () => undefined;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const emitted: unknown[] = [];
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25 } }), port, {
        emitEvent: (event) => emitted.push(event),
        eventIdFactory: () => 'event-tool',
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('hello');

      // A long-running tool starts. This is the scenario where a build/install
      // produces no SSE progress for far longer than the idle window.
      onEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'opencode-new',
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: { status: 'running', input: { command: 'cargo build' } },
          },
        },
      });

      // Far past the idle window, but the tool is still running: the guard
      // must stay suspended and must NOT abort the session.
      await vi.advanceTimersByTimeAsync(2000);
      expect(client.abort).not.toHaveBeenCalled();
      expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(false);

      // The tool finishes. The guard re-arms; with no further progress and no
      // terminal event, the idle window now elapses and the turn is aborted.
      onEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'opencode-new',
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: { status: 'completed', output: 'done' },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(26);
      expect(client.abort).toHaveBeenCalledWith('opencode-new');
      expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(true);

      await sendPromise;
    } finally {
      vi.useRealTimers();
    }
  });
  it('re-arms the idle guard after an answered permission expires the turn', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      client.prompt.mockResolvedValue(undefined);
      client.respondToPermission.mockResolvedValue(true);
      let onEvent: (event: unknown) => void = () => undefined;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const emitted: unknown[] = [];
      const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25, approval_timeout_ms: 0 } }), port, {
        emitEvent: (event) => emitted.push(event),
        eventIdFactory: () => 'event-rearm',
      } as any);

      await runtime.start();
      const sendPromise = runtime.sendInput('hello');
      onEvent({
        type: 'permission.asked',
        properties: { id: 'perm-1', sessionID: 'opencode-new', type: 'write', title: 'edit file' },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(client.abort).not.toHaveBeenCalled();

      await runtime.respondToPermission('perm-1', 'once', 'codemux-session-1');

      await vi.advanceTimersByTimeAsync(26);
      expect(client.abort).toHaveBeenCalledWith('opencode-new');
      expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(true);

      await sendPromise;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not emit a user message part as assistant output in the live runtime path', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    onEvent({ type: 'message.updated', properties: { sessionID: 'opencode-new', info: { id: 'user-message-1', role: 'user' } } });
    onEvent({ type: 'message.part.updated', properties: { sessionID: 'opencode-new', part: { id: 'user-part-1', sessionID: 'opencode-new', messageID: 'user-message-1', type: 'text', text: 'hello' }, delta: 'hello' } });

    expect(emitted.some((event) => (event as { type?: string }).type === 'assistant_message')).toBe(false);
    await runtime.shutdown();
  });

  it('registers native permission requests before emitting a unified permission event', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { agentId: 'agent-1', emitEvent: (event) => emitted.push(event), eventIdFactory: () => 'event-1' });
    await runtime.start();

    const rawPermission = { id: 'permission-1', sessionID: 'opencode-new', type: 'future_permission', title: 'Do something', metadata: { path: 'a.txt' } };
    onEvent({ type: 'permission.updated', properties: rawPermission });

    expect(runtime.permissions.get('permission-1')).toMatchObject({ permissionType: 'future_permission', raw: rawPermission });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'permission_requested',
      request_id: 'permission-1',
      agent_id: 'agent-1',
      session_id: 'codemux-session-1',
      opencode_session_id: 'opencode-new',
      permission_type: 'future_permission',
      description: 'Do something',
      metadata: rawPermission.metadata,
    }));
    await runtime.respondToPermission('permission-1', { approved: true });
    expect(client.respondToPermission).toHaveBeenCalledWith({ sessionId: 'opencode-new', requestId: 'permission-1', response: 'once' });
    await runtime.shutdown();
  });

  it('registers and responds to the permission.asked event emitted by current OpenCode runtimes', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    const rawPermission = {
      id: 'permission-asked-1',
      sessionID: 'opencode-new',
      permission: 'external_directory',
      metadata: { filepath: 'C:\\Users\\user\\.agents' },
      patterns: ['C:\\Users\\user\\.agents\\**'],
      always: ['*'],
      tool: { messageID: 'message-1', callID: 'call-1' },
    };
    onEvent({ type: 'permission.asked', properties: rawPermission });

    expect(runtime.permissions.get('permission-asked-1')).toMatchObject({
      permissionType: 'external_directory',
      raw: rawPermission,
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'permission_requested',
      request_id: 'permission-asked-1',
      permission_type: 'external_directory',
      description: 'external_directory',
      metadata: {
        ...rawPermission.metadata,
        patterns: rawPermission.patterns,
        always: rawPermission.always,
        tool: rawPermission.tool,
      },
    }));
    await runtime.respondToPermission('permission-asked-1', 'once');
    expect(client.respondToPermission).toHaveBeenCalledWith({
      sessionId: 'opencode-new',
      requestId: 'permission-asked-1',
      response: 'once',
    });
    await runtime.shutdown();
  });

  it('cancels pending permissions during interrupt without calling native response twice', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    onEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: {} } });
    await runtime.interrupt();
    expect(runtime.permissions.size).toBe(0);
    expect(client.respondToPermission).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
    expect(client.respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('blocks new permission registrations during interrupt and leaves no pending requests', async () => {
    const { port, client } = createPort();
    let onEvent!: (event: unknown) => void;
    let resolveCancellation!: () => void;
    const cancellation = new Promise<boolean>((resolve) => { resolveCancellation = () => resolve(true); });
    client.respondToPermission = vi.fn().mockReturnValue(cancellation);
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    onEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: {} } });

    const interrupt = runtime.interrupt();
    await vi.waitFor(() => expect(client.respondToPermission).toHaveBeenCalledTimes(1));
    onEvent({ type: 'permission.updated', properties: { id: 'permission-2', sessionID: 'opencode-new', type: 'write', title: 'Write', metadata: {} } });
    expect(runtime.permissions.size).toBe(0);
    resolveCancellation();
    await interrupt;
    expect(runtime.permissions.size).toBe(0);
    await runtime.shutdown();
  });

  it('updates changed permission payloads and emits one event per changed payload', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const first = { type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: { path: 'a.txt' } } };
    const changed = { type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'write', title: 'Write', metadata: { path: 'b.txt' } } };
    onEvent(first);
    onEvent(first);
    onEvent(changed);

    expect(emitted.filter((event) => (event as { type?: string }).type === 'permission_requested')).toHaveLength(2);
    expect(runtime.permissions.get('permission-1')).toMatchObject({ permissionType: 'write', description: 'Write', raw: changed.properties });
    await runtime.shutdown();
  });

  it('re-registers a changed payload without native identity after timeout while suppressing the old replay', async () => {
    vi.useFakeTimers();
    try {
      const { port, client } = createPort();
      const emitted: unknown[] = [];
      let onEvent!: (event: unknown) => void;
      client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
        onEvent = input.onEvent;
        return { close: vi.fn() };
      });
      const runtime = new OpenCodeRuntime(createConfig(), port, {
        emitEvent: (event) => emitted.push(event),
        permissionTimeoutMs: 25,
      });
      await runtime.start();

      const payloadA = { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: { path: 'a.txt' } };
      const payloadB = { id: 'permission-1', sessionID: 'opencode-new', type: 'write', title: 'Write', metadata: { path: 'b.txt' } };
      onEvent({ type: 'permission.updated', properties: payloadA });
      await vi.advanceTimersByTimeAsync(25);
      expect(runtime.permissions.size).toBe(0);

      onEvent({ type: 'permission.updated', properties: payloadA });
      expect(emitted.filter((event) => (event as { type?: string }).type === 'permission_requested')).toHaveLength(1);
      expect(runtime.permissions.size).toBe(0);

      onEvent({ type: 'permission.updated', properties: payloadB });
      expect(emitted.filter((event) => (event as { type?: string }).type === 'permission_requested')).toHaveLength(2);
      expect(runtime.permissions.get('permission-1')).toMatchObject({
        permissionType: 'write',
        raw: payloadB,
      });
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps permission registration closed until reset cleanup completes', async () => {
    const { port, client } = createPort();
    let onEvent!: (event: unknown) => void;
    let resolveCancellation!: () => void;
    const cancellation = new Promise<boolean>((resolve) => { resolveCancellation = () => resolve(true); });
    client.respondToPermission = vi.fn().mockReturnValue(cancellation);
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    onEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: {} } });

    const reset = runtime.resetSession();
    await vi.waitFor(() => expect(client.respondToPermission).toHaveBeenCalledTimes(1));
    onEvent({ type: 'permission.updated', properties: { id: 'permission-2', sessionID: 'opencode-new', type: 'write', title: 'Write', metadata: {} } });
    expect(runtime.permissions.size).toBe(0);
    resolveCancellation();
    await reset;
    expect(runtime.permissions.size).toBe(0);
    await runtime.shutdown();
  });

  it('bounds shutdown while native permission rejection hangs', async () => {
    const { port, client } = createPort();
    let onEvent!: (event: unknown) => void;
    client.respondToPermission = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}));
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { nativeResponseTimeoutMs: 20 });
    await runtime.start();
    onEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-new', type: 'read', title: 'Read', metadata: {} } });

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(runtime.permissions.size).toBe(0);
    expect(client.respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('subscribes to SDK events, normalizes them, and deduplicates repeated events', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn().mockResolvedValue(undefined) };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { agentId: 'agent-1', emitEvent: (event) => emitted.push(event) });

    await runtime.start();
    const event = { type: 'message.part.updated', id: 'event-1', properties: { part: { id: 'part-1', sessionID: 'opencode-new', messageID: 'message-1', type: 'text', text: 'hi' }, delta: 'hi' } };
    onEvent(event);
    onEvent(event);

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toMatchObject({ type: 'assistant_message', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-new', sequence: 0 });
    await runtime.shutdown();
    expect(client.subscribe).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'D:/workspace/demo' }));
  });
  it('starts an isolated server before creating a new session and returns the mapping', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const mapping = await runtime.start();

    expect(port.start).toHaveBeenCalledWith({ cwd: 'D:/workspace/demo', provider: 'codemux-openai', model: 'gpt-5', apiKey: 'secret-key', baseUrl: 'https://provider.example/v1', credentialSource: 'codemux', runtimeRef: sdkMocks.runtimeRef, serverCloseTimeoutMs: 10_000 });
    expect(client.createSession).toHaveBeenCalledWith({ cwd: 'D:/workspace/demo' });
    expect(mapping).toEqual<OpenCodeSessionMapping>({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
      runtimeGeneration: 1,
    });
  });

  it('reuses one start promise for concurrent start calls', async () => {
    const { port, server, client } = createPort();
    const startResources = deferred<{ server: typeof server; client: typeof client }>();
    port.start.mockReturnValueOnce(startResources.promise);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    expect(secondStart).toBe(firstStart);
    expect(port.start).toHaveBeenCalledTimes(0);

    startResources.resolve({ server, client });
    await expect(firstStart).resolves.toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
      runtimeGeneration: 1,
    });
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('serializes shutdown after an in-flight start without reviving the runtime', async () => {
    const { port, server, client } = createPort();
    const startResources = deferred<{ server: typeof server; client: typeof client }>();
    port.start.mockReturnValueOnce(startResources.promise);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const startPromise = runtime.start();
    const shutdownPromise = runtime.shutdown();
    startResources.resolve({ server, client });

    await expect(startPromise).resolves.toBeDefined();
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state disposed');
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('rejects new prompts once shutdown has been requested', async () => {
    const { port, server } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    const shutdownPromise = runtime.shutdown();
    await expect(runtime.sendInput('late prompt')).rejects.toThrow('OpenCode runtime is shutting down');
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(1);
  });
  it('fails start and runs cleanup when event subscription initialization rejects', async () => {
    const { port, client, server } = createPort();
    client.subscribe = vi.fn().mockRejectedValue(new Error('subscribe unavailable'));
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await expect(runtime.start()).rejects.toThrow('subscribe unavailable');
    expect(server.close).toHaveBeenCalledTimes(1);
  });
  it('restores an existing session and never creates a replacement when restoration fails', async () => {
    const { port, client } = createPort();
    client.restoreSession.mockRejectedValue(new Error('session not found'));
    const runtime = new OpenCodeRuntime(createConfig({ agentSessionId: 'opencode-missing' }), port);

    await expect(runtime.start()).rejects.toThrow(
      'Failed to restore OpenCode session "opencode-missing": session not found',
    );
    expect(client.createSession).not.toHaveBeenCalled();
    await expect(runtime.start()).rejects.toThrow('Failed to restore OpenCode session "opencode-missing": session not found');
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('normalizes conflicting prompt and payload text using the command prompt as the source of truth', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    const inputPayload: AgentInputPayload = { text: 'payload text', images: [] };

    await runtime.sendInput('prompt text', inputPayload);

    expect(client.prompt).toHaveBeenCalledWith({
      sessionId: 'opencode-new',
      prompt: 'prompt text',
      inputPayload: {
        text: 'prompt text',
        attachments: [],
        images: [],
      },
      images: [],
      provider: 'codemux-openai',
      model: 'gpt-5',
      agent: 'build',
    });
  });

  it('routes /compact through the native OpenCode compaction API and waits for completion', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    const compactPromise = runtime.sendInput('/compact');
    await vi.waitFor(() => expect(client.compactSession).toHaveBeenCalledWith({
      cwd: 'D:/workspace/demo',
      sessionId: 'opencode-new',
      provider: 'codemux-openai',
      model: 'gpt-5',
    }));
    expect(client.prompt).not.toHaveBeenCalled();

    onEvent({
      type: 'session.next.compaction.started',
      properties: { sessionID: 'opencode-new', reason: 'manual' },
    });
    onEvent({
      type: 'session.next.compaction.ended',
      properties: { sessionID: 'opencode-new', reason: 'manual' },
    });
    await compactPromise;

    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system_event', subtype: 'compact_boundary' }),
      expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
    ]));
    await runtime.shutdown();
  });

  it('deletes the native OpenCode session through the client port', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await runtime.deleteSession('opencode-new');

    expect(client.deleteSession).toHaveBeenCalledWith({ cwd: 'D:/workspace/demo', sessionId: 'opencode-new' });
  });

  it('forks the native OpenCode session at a provider message', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await expect(runtime.forkSession(
      'opencode-new',
      undefined,
      undefined,
      'assistant-message-1',
    )).resolves.toBe('opencode-forked');

    expect(client.forkSession).toHaveBeenCalledWith({
      cwd: 'D:/workspace/demo',
      sessionId: 'opencode-new',
      messageId: 'assistant-message-1',
    });
  });

  it('rejects an OpenCode fork while a turn is active', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    const pending = deferred<void>();
    client.prompt.mockReturnValueOnce(pending.promise);

    const input = runtime.sendInput('keep running');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());

    await expect(runtime.forkSession(undefined, undefined, undefined, 'assistant-message-1'))
      .rejects.toThrow('Cannot fork while an OpenCode turn is active');
    pending.resolve();
    await input;
  });

  it('sends text and image payloads to the adapter without exposing SDK objects', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    const inputPayload: AgentInputPayload = {
      text: 'hello',
      images: [{ name: 'diagram.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await expect(runtime.sendInput('hello', inputPayload)).resolves.toBeUndefined();
    expect(client.prompt).toHaveBeenCalledWith({
      sessionId: 'opencode-new',
      prompt: 'hello',
      inputPayload: {
        text: 'hello',
        attachments: [{
          type: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          size: undefined,
        }],
        images: [{
          name: 'diagram.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          size: undefined,
        }],
      },
      images: [{
        name: 'diagram.png',
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,abc',
        size: undefined,
      }],
      provider: 'codemux-openai',
      model: 'gpt-5',
      agent: 'build',
    });
  });

  it('bounds official adapter startup cleanup and preserves the server for runtime retry', async () => {
    const serverClose = vi.fn(() => new Promise<void>(() => undefined));
    sdkMocks.createServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4098',
      close: serverClose,
    });
    sdkMocks.createClient.mockImplementationOnce(() => {
      throw new Error('client initialization failed');
    });
    const runtime = new OpenCodeRuntime(createConfig(), officialOpenCodeSdkPort, {
      serverCloseTimeoutMs: 10,
    });

    const startedAt = Date.now();
    const startError = await runtime.start().catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(startError).toBeInstanceOf(AggregateError);
    expect(serverClose).toHaveBeenCalledTimes(1);
    await runtime.shutdown().catch(() => undefined);
    expect(serverClose).toHaveBeenCalledTimes(2);
  });
  it('maps the official adapter prompt body and images to OpenCode SDK parts', async () => {
    sdkMocks.promptAsync.mockClear();
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'codemux-openai', model: 'model-1', credentialSource: 'none', runtimeRef: sdkMocks.runtimeRef });

    await resources.client.prompt({
      sessionId: 'opencode-new',
      prompt: 'fallback text',
      inputPayload: { text: 'payload text', images: [] },
      images: [{ name: 'diagram.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      provider: 'codemux-openai',
      model: 'gpt-5',
    });

    expect(sdkMocks.promptAsync).toHaveBeenCalledWith({
      path: { id: 'opencode-new' },
      query: { directory: 'D:/workspace/demo' },
      body: {
        model: { providerID: 'codemux-openai', modelID: 'gpt-5' },
        parts: [
          { type: 'text', text: 'payload text' },
          { type: 'file', mime: 'image/png', filename: 'diagram.png', url: 'data:image/png;base64,abc' },
        ],
      },
    });
  });

  it('formats structured SDK errors without falling back to object stringification', async () => {
    sdkMocks.client.session.create.mockResolvedValueOnce({
      error: { code: 404, message: 'session unavailable' },
    });
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'codemux-openai', model: 'model-1', credentialSource: 'none', runtimeRef: sdkMocks.runtimeRef });

    await expect(resources.client.createSession({ cwd: 'D:/workspace/demo' })).rejects.toThrow(
      'OpenCode session creation failed: {"code":404,"message":"session unavailable"}',
    );
  });
  it('interrupts an active task and treats abort rejection as an expected interruption', async () => {
    const { port, client } = createPort();
    let rejectPrompt!: (reason: unknown) => void;
    client.prompt.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPrompt = reject; }));
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    const sendPromise = runtime.sendInput('long task');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
    await expect(runtime.interrupt()).resolves.toBeUndefined();
    rejectPrompt(new DOMException('The operation was aborted', 'AbortError'));
    await expect(sendPromise).resolves.toBeUndefined();
    expect(client.abort).toHaveBeenCalledWith('opencode-new');
  });

  it('continues cleanup after interrupt and active task failures, then aggregates errors', async () => {
    const { port, server, client } = createPort();
    let rejectPrompt!: (reason: unknown) => void;
    client.prompt.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPrompt = reject; }));
    client.abort.mockRejectedValueOnce(new Error('interrupt failed'));
    server.close.mockRejectedValueOnce(new Error('server close failed'));
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    void runtime.sendInput('long task').catch(() => undefined);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
    rejectPrompt(new Error('active task failed'));

    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect(String(cleanupError)).toContain('OpenCode runtime cleanup failed');
    expect(server.close).toHaveBeenCalledTimes(1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
  });

  it('bounds cleanup when the active task never settles and abort fails', async () => {
    const { port, server, client } = createPort();
    client.prompt.mockReturnValueOnce(new Promise<void>(() => undefined));
    client.abort.mockRejectedValueOnce(new Error('abort failed'));
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      activeTaskTimeoutMs: 10,
    });
    await runtime.start();
    void runtime.sendInput('never ending task');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());

    const startedAt = Date.now();
    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    const cleanupMessages = (cleanupError as AggregateError).errors.map((error) => String(error)).join('\n');
    expect(cleanupMessages).toContain('OpenCode active task cleanup timed out after 10ms');
    expect(cleanupMessages).toContain('abort failed');
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging server close, retains it, and retries cleanup', async () => {
    const { port, server } = createPort();
    server.close
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValueOnce(undefined);
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      serverCloseTimeoutMs: 10,
    });
    await runtime.start();

    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors.map(String).join('\n')).toContain(
      'OpenCode server close timed out after 10ms',
    );
    expect(server.close).toHaveBeenCalledTimes(1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state disposed');
  });

  it('does not start a new server after dispose and remains idempotent', async () => {
    const { port, server, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await runtime.shutdown();
    await runtime.dispose();
    await runtime.shutdown();

    expect(client.abort).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(port.start).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state disposed');
    await expect(runtime.sendInput('after dispose')).rejects.toThrow('OpenCode runtime is not started');
  });

  it('recovers to a retryable state when sdk.start fails after creating partial resources', async () => {
    const { port, server, client } = createPort();
    const startFailure = Object.assign(new Error('client creation failed'), {
      resources: { server, client },
    }) as OpenCodeSdkStartFailure;
    port.start
      .mockRejectedValueOnce(startFailure)
      .mockResolvedValueOnce({ server, client });
    const runtime = new OpenCodeRuntime(createConfig(), port);

    await expect(runtime.start()).rejects.toThrow('client creation failed');
    expect(server.close).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).resolves.toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
      runtimeGeneration: 1,
    });
    expect(port.start).toHaveBeenCalledTimes(2);
  });

  it('retains a server when session startup and its close both fail, then shuts it down on retry', async () => {
    const { port, server, client } = createPort();
    client.createSession.mockRejectedValueOnce(new Error('session creation failed'));
    server.close
      .mockRejectedValueOnce(new Error('server close failed'))
      .mockResolvedValue(undefined);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    await expect(runtime.start()).rejects.toThrow('OpenCode start failed and cleanup failed');
    expect(port.start).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state cleanup_failed');

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('resetSession clears the current session and allows a new one on the next start', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await runtime.resetSession();
    await runtime.start();

    expect(client.createSession).toHaveBeenCalledTimes(2);
  });

  it('filters events from old and unrelated OpenCode sessions', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => { onEvent = input.onEvent; return { close: vi.fn() }; });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'old', sessionID: 'old-session', messageID: 'm', type: 'text', text: 'old' }, delta: 'old' } });
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'other', sessionID: 'other-session', messageID: 'm', type: 'text', text: 'other' }, delta: 'other' } });
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'current', sessionID: 'opencode-new', messageID: 'm', type: 'text', text: 'current' }, delta: 'current' } });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toMatchObject({ type: 'assistant_message', content: [{ text: 'current' }] });
    await runtime.shutdown();
  });

  it('emits one terminal result and ignores late tool starts and duplicate interruption', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => { onEvent = input.onEvent; return { close: vi.fn() }; });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const complete = { type: 'session.idle', properties: { sessionID: 'opencode-new' } };
    onEvent(complete);
    onEvent({ type: 'session.error', properties: { sessionID: 'opencode-new', error: { name: 'UnknownError', data: { message: 'late error' } } } });
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'tool-part', sessionID: 'opencode-new', messageID: 'm', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'completed', input: {}, output: 'done', title: 'bash', metadata: {}, time: { start: 1, end: 2 } } } } });
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'tool-part', sessionID: 'opencode-new', messageID: 'm', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'running', input: {} } } } });
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));
    expect(emitted.filter((event) => (event as { type?: string }).event_kind === 'tool_call')).toHaveLength(0);
    await runtime.shutdown();
  });

  it('clears event state when resetting to a new OpenCode session', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => { onEvent = input.onEvent; return { close: vi.fn() }; });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const oldEvent = { type: 'message.part.updated', properties: { part: { id: 'same-part', sessionID: 'opencode-new', messageID: 'm', type: 'text', text: 'first' }, delta: 'first' } };
    onEvent(oldEvent);
    await runtime.resetSession();
    client.createSession.mockResolvedValueOnce({ id: 'opencode-reset' });
    await runtime.start();
    onEvent({ ...oldEvent, properties: { ...oldEvent.properties, part: { ...(oldEvent.properties as { part: Record<string, unknown> }).part, sessionID: 'opencode-reset' } } });
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'assistant_message')).toHaveLength(2));
    await runtime.shutdown();
  });

  it('allows two prompt turns in one OpenCode session to emit separate terminal results', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    const firstSend = runtime.sendInput('first turn');
    onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new', id: 'idle-1' } });
    await firstSend;
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));

    const secondSend = runtime.sendInput('second turn');
    onEvent({ type: 'session.status', properties: { sessionID: 'opencode-new', status: { type: 'busy' } } });
    onEvent({ type: 'session.idle', id: 'idle-2', properties: { sessionID: 'opencode-new' } });
    await secondSend;
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(2));

    await runtime.shutdown();
  });

  it('turns an adapter disconnect signal into one disconnected terminal result', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onDisconnect!: (error: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onDisconnect: (error: unknown) => void }) => { onDisconnect = input.onDisconnect; return { close: vi.fn() }; });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    const disconnectError = new Error('socket lost');
    onDisconnect(disconnectError);
    onDisconnect(disconnectError);
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', subtype: 'disconnected', error: 'socket lost' })]));
    await runtime.shutdown();
  });

  it('suppresses a cross-turn replay until the new turn has observable activity', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => { onEvent = input.onEvent; return { close: vi.fn() }; });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const idle = { type: 'session.idle', id: 'idle-1', properties: { sessionID: 'opencode-new' } };
    onEvent(idle);
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));

    const secondSend = runtime.sendInput('second turn');
    onEvent({ type: 'session.status', properties: { sessionID: 'opencode-new', status: { type: 'busy' } } });
    onEvent(idle);
    expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1);
    onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new', id: 'idle-2' } });
    await secondSend;
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(2));
    await runtime.shutdown();
  });

  it('preserves text deltas and tool state transitions when part IDs repeat', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    const textPart = (delta: string) => ({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-new', messageID: 'message-1', type: 'text' }, delta } });
    onEvent(textPart('first'));
    onEvent(textPart('first'));
    onEvent(textPart('second'));
    const toolPart = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'message.part.updated', properties: { part: { id: 'tool-part-1', sessionID: 'opencode-new', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'search', state: { status, input: {}, ...extra } } } });
    onEvent(toolPart('running'));
    onEvent(toolPart('running'));
    onEvent(toolPart('completed', { output: { matches: ['a'] } }));
    onEvent(toolPart('running'));

    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'tool_finished')).toHaveLength(1));
    expect(emitted.filter((event) => (event as { type?: string }).type === 'assistant_message')).toHaveLength(2);
    expect(emitted.filter((event) => (event as { type?: string }).type === 'tool_started')).toHaveLength(1);
    expect(emitted.filter((event) => (event as { type?: string }).type === 'tool_finished')).toMatchObject([{
      tool_use_id: 'call-1', content: '{"matches":["a"]}', is_error: false,
    }]);
    await runtime.shutdown();
  });
  it('suppresses identical unknown event replays without suppressing changed payloads', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    onEvent({ type: 'future.event', properties: { sessionID: 'opencode-new', value: 1 } });
    onEvent({ type: 'future.event', properties: { sessionID: 'opencode-new', value: 1 } });
    onEvent({ type: 'future.event', properties: { sessionID: 'opencode-new', value: 2 } });
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { subtype?: string }).subtype === 'unknown_event')).toHaveLength(2));
    await runtime.shutdown();
  });
  it('does not let sessionless usage events contaminate the active session result', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    onEvent({ type: 'message.updated', properties: { info: { tokens: { input: 99, output: 88, reasoning: 77, cache: { read: 66, write: 55 } } } } });
    onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'diagnostic', subtype: 'missing_session_id' })]));
    expect(emitted.find((event) => (event as { type?: string }).type === 'turn_finished')).toMatchObject({ type: 'turn_finished', outcome: 'completed' });
    expect(emitted.find((event) => (event as { type?: string }).type === 'turn_finished')).not.toHaveProperty('usage');
    await runtime.shutdown();
  });

  it('deduplicates sessionless diagnostics by event or payload identity', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const sessionlessMessage = (value: number) => ({ type: 'message.updated', properties: { info: { tokens: { input: value, output: value } } } });
    onEvent(sessionlessMessage(1));
    onEvent(sessionlessMessage(1));
    onEvent(sessionlessMessage(2));
    onEvent({ type: 'future.sessionless', properties: { value: 'same' } });
    onEvent({ type: 'future.sessionless', properties: { value: 'same' } });
    onEvent({ type: 'future.sessionless', properties: { value: 'changed' } });
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { subtype?: string }).subtype === 'missing_session_id')).toHaveLength(2));
    expect(emitted.filter((event) => (event as { subtype?: string }).subtype === 'unknown_event')).toHaveLength(2);
    await runtime.shutdown();
  });
  it('allows the official ID-less session.idle fixture to complete two prompt turns', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();
    const idle = { type: 'session.idle', properties: { sessionID: 'opencode-new' } };

    const firstSend = runtime.sendInput('first turn');
    onEvent(idle);
    await firstSend;
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));

    const secondSend = runtime.sendInput('second turn');
    onEvent(idle);
    await secondSend;
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(2));
    await runtime.shutdown();
  });

  it('does not terminate on a recoverable SSE retry and resumes event handling', async () => {
    const { port, client } = createPort();
    const emitted: unknown[] = [];
    let onRetry!: (error: unknown) => void;
    let onDisconnect!: (error: unknown) => void;
    let onEvent!: (event: unknown) => void;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void; onRetry: (error: unknown) => void; onDisconnect: (error: unknown) => void }) => {
      onEvent = input.onEvent;
      onRetry = input.onRetry;
      onDisconnect = input.onDisconnect;
      return { close: vi.fn() };
    });
    const runtime = new OpenCodeRuntime(createConfig(), port, { emitEvent: (event) => emitted.push(event) });
    await runtime.start();

    onRetry(new Error('temporary socket failure'));
    onEvent({ type: 'message.part.updated', properties: { part: { id: 'after-retry', sessionID: 'opencode-new', messageID: 'm', type: 'text', text: 'resumed' }, delta: 'resumed' } });
    await vi.waitFor(() => expect(emitted.some((event) => (event as { type?: string }).type === 'assistant_message')).toBe(true));
    expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(false);

    onDisconnect(new Error('stream ended'));
    await vi.waitFor(() => expect(emitted.filter((event) => (event as { type?: string }).type === 'turn_finished')).toHaveLength(1));
    await runtime.shutdown();
  });
});
