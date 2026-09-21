import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { SidecarCommand } from './types.js';
import { buildOpenCodeSessionMappingEvent, buildUserMessageEvent, createSidecarCommandDispatcher, waitForWarmup } from './index.js';
// 静态导入:在 it() 内 await import 会把首次模块图加载计入该用例的超时预算。
import { SteerUnavailableError } from './steer.js';

function createRuntime() {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    canReuse: vi.fn().mockReturnValue(false),
    emitSessionMapping: vi.fn(),
    updatePermissions: vi.fn(),
    sendInput: vi.fn().mockResolvedValue(undefined),
    steerActiveTurn: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue('forked-session'),
    resetSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockResolvedValue(undefined),
  };
}

describe('sidecar command dispatcher', () => {
  it('builds a canonical user message while preserving display text and images', () => {
    expect(buildUserMessageEvent('session-1', 'generated prompt', {
      text: 'generated prompt',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
    }, '/review')).toMatchObject({
      type: 'user_message',
      session_id: 'session-1',
      content: [
        { type: 'text', text: '/review' },
        { type: 'image', name: 'screen.png' },
      ],
    });
  });

  it.skipIf(process.platform !== 'win32')('emits readiness when Node receives a Windows verbatim script path', () => {
    const entrypoint = path.resolve('dist/index.js');
    const verbatimEntrypoint = `\\\\?\\${entrypoint}`;
    let output: string;
    try {
      output = execFileSync(process.execPath, [verbatimEntrypoint], {
        encoding: 'utf8',
        input: '',
      });
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr
        : String(error);
      // Known Node.js regression (nodejs/node#60435): Node 22.20+/24 fail to
      // load DOS-device (\\?\) entry paths — the CJS loader reduces the path to
      // a bare drive letter and realpathSync throws "EISDIR: lstat 'X:'".
      // The Rust host strips the prefix before spawning Node (see
      // strip_windows_long_path_prefix in crates/daemon), so skip on affected Node
      // builds instead of failing; the real assertion still runs on fixed Nodes.
      if (/EISDIR[^\n]*lstat '[A-Za-z]:'/.test(stderr)) {
        console.warn(
          `[skip] Node ${process.version} cannot load \\\\?\\ entry paths (nodejs/node#60435); `
          + 'the Rust host strips the prefix before spawning Node.',
        );
        return;
      }
      throw error;
    }

    expect(output).toContain('{"type":"sidecar_ready"}');
  });

  it('builds the OpenCode agent session mapping event from the runtime mapping', () => {
    expect(buildOpenCodeSessionMappingEvent({
      sessionId: 'app-session',
      agentSessionId: 'opencode-session',
      runtimeGeneration: 3,
    })).toEqual({
      type: 'agent_session_mapping',
      app_session_id: 'app-session',
      agent_kind: 'opencode',
      agent_session_id: 'opencode-session',
      runtime_generation: 3,
    });
  });

  it('forks through the active Claude runtime and returns the provider session ID', async () => {
    const claude = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'claude_code',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'source-session',
    });
    await dispatcher.dispatch({
      type: 'fork_session',
      sessionId: 'session-1',
      requestId: 'request-1',
      sourceAgentSessionId: 'staged-session',
      sourceProviderTurnId: 'turn-1',
      sourceProviderTurnOrdinal: 0,
    });

    expect(claude.forkSession).toHaveBeenCalledTimes(1);
    expect(claude.forkSession).toHaveBeenCalledWith('staged-session', 'turn-1', 0, undefined);
    expect(emit).toHaveBeenCalledWith({
      type: 'session_fork_result',
      request_id: 'request-1',
      session_id: 'session-1',
      agent_kind: 'claude_code',
      agent_session_id: 'forked-session',
      ok: true,
    });
  });

  it('rewinds the conversation through the active runtime and reports the new native session', async () => {
    const opencode = createRuntime();
    (opencode as Record<string, unknown>).rewindConversation = vi
      .fn()
      .mockResolvedValue('rewound-session');
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'native-session',
    });
    await dispatcher.dispatch({
      type: 'rewind_conversation',
      sessionId: 'session-1',
      requestId: 'request-rewind',
      providerMessageId: 'msg_boundary',
    });

    expect(opencode.rewindConversation).toHaveBeenCalledWith({
      entryId: undefined,
      providerMessageId: 'msg_boundary',
      providerMessageTurnOrdinal: undefined,
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'session_rewind_conversation_result',
      request_id: 'request-rewind',
      session_id: 'session-1',
      ok: true,
      agent_session_id: 'rewound-session',
    });
  });

  it('reports rewind_conversation failures on the result event instead of crashing the loop', async () => {
    const opencode = createRuntime();
    (opencode as Record<string, unknown>).rewindConversation = vi
      .fn()
      .mockRejectedValue(new Error('OpenCode runtime is not started'));
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'native-session',
    });
    await dispatcher.dispatch({
      type: 'rewind_conversation',
      sessionId: 'session-1',
      requestId: 'request-rewind-fail',
      providerMessageId: 'msg_boundary',
    });

    expect(emit).toHaveBeenCalledWith({
      type: 'session_rewind_conversation_result',
      request_id: 'request-rewind-fail',
      session_id: 'session-1',
      ok: false,
      error: 'Error: OpenCode runtime is not started',
    });
  });

  it('forks through the active Codex runtime at the selected provider turn', async () => {
    const codex = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: codex,
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'codex',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'source-thread',
    });
    await dispatcher.dispatch({
      type: 'fork_session',
      sessionId: 'session-1',
      requestId: 'request-2',
      sourceAgentSessionId: 'source-thread',
      sourceProviderTurnId: 'turn-2',
      sourceProviderTurnOrdinal: 1,
    });

    expect(codex.forkSession).toHaveBeenCalledWith('source-thread', 'turn-2', 1, undefined);
    expect(emit).toHaveBeenCalledWith({
      type: 'session_fork_result',
      request_id: 'request-2',
      session_id: 'session-1',
      agent_kind: 'codex',
      agent_session_id: 'forked-session',
      ok: true,
    });
  });

  it('forks through the active OpenCode runtime at the selected provider message', async () => {
    const opencode = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'source-session',
    });
    await dispatcher.dispatch({
      type: 'fork_session',
      sessionId: 'session-1',
      requestId: 'request-3',
      sourceAgentSessionId: 'source-session',
      sourceProviderMessageId: 'assistant-message-1',
    });

    expect(opencode.forkSession).toHaveBeenCalledWith(
      'source-session',
      undefined,
      undefined,
      'assistant-message-1',
    );
    expect(emit).toHaveBeenCalledWith({
      type: 'session_fork_result',
      request_id: 'request-3',
      session_id: 'session-1',
      agent_kind: 'opencode',
      agent_session_id: 'forked-session',
      ok: true,
    });
  });

  it('routes OpenCode lifecycle commands and permission responses', async () => {
    const opencode = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1', provider: 'codemux-openai', model: 'gpt-5' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'opencode', sessionId: 'session-1', permissionConfig: { mode: 'default' } });
    await dispatcher.dispatch({ type: 'send_input', sessionId: 'session-1', prompt: 'hello' });
    await dispatcher.dispatch({ type: 'reset_session', sessionId: 'session-1' });
    await dispatcher.dispatch({
      type: 'delete_session',
      sessionId: 'session-1',
      agentSessionId: 'opencode-session-1',
      requestId: 'request-1',
      runtimeRef: {
        provider: 'opencode',
        runtimeRoot: 'D:\\runtimes',
        runtimePath: 'D:\\runtimes\\opencode\\1.18.3',
        runtimeVersion: '1.18.3',
      },
    });
    await dispatcher.dispatch({ type: 'interrupt' });
    await dispatcher.dispatch({ type: 'tool_response', toolUseId: 'tool-1', response: { approved: true } });
    await dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: { approved: true } });

    expect(opencode.ensure).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_message', session_id: 'session-1', content: 'hello' }));
    expect(opencode.updatePermissions).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_permissions',
      agentKind: 'opencode',
      sessionId: 'session-1',
    }));
    expect(opencode.sendInput).toHaveBeenCalledWith('hello', undefined);
    expect(opencode.resetSession).toHaveBeenCalledWith('session-1');
    expect(opencode.deleteSession).toHaveBeenCalledWith('opencode-session-1');
    expect(emit).toHaveBeenCalledWith({
      type: 'session_delete_result',
      request_id: 'request-1',
      session_id: 'session-1',
      ok: true,
    });
    expect(opencode.interrupt).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'sidecar_error',
      error: 'OpenCode tool responses are server-managed/not supported',
    });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'opencode', sessionId: 'session-1', planMode: 'on' });
    expect(opencode.updatePermissions).toHaveBeenCalledTimes(2);
    expect(opencode.respondToPermission).toHaveBeenCalledWith('permission-1', { approved: true }, 'session-1');
  });

  it('fails the turn when send_input runs without an active managed runtime', async () => {
    const failingOpenCode = {
      ...createRuntime(),
      ensure: vi.fn().mockRejectedValue(new Error('OpenCode SDK start failed')),
      canReuse: vi.fn().mockReturnValue(false),
    };
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => failingOpenCode),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1', provider: 'codemux-openai', model: 'gpt-5' });
    await dispatcher.dispatch({ type: 'send_input', sessionId: 'session-1', prompt: 'hello' });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      session_id: 'session-1',
      subtype: 'failed',
    }));
    expect(emit).toHaveBeenCalledWith({
      type: 'sidecar_error',
      error: expect.stringContaining('runtime is not initialized'),
    });
  });

  it('routes Codex permission responses and pending question answers through the Codex runtime', async () => {
    const codex = {
      ...createRuntime(),
      isPendingQuestion: vi.fn().mockReturnValue(true),
      respondToQuestion: vi.fn().mockResolvedValue(undefined),
    };
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: codex,
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'codex', cwd: 'D:\\workspace', sessionId: 'codex-session' });
    await dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'codex-session', response: 'once' });
    await dispatcher.dispatch({ type: 'tool_response', toolUseId: 'question-1', response: [['是']] });

    await vi.waitFor(() => {
      expect(codex.respondToPermission).toHaveBeenCalledWith('permission-1', 'once', 'codex-session');
    });
    await vi.waitFor(() => {
      expect(codex.respondToQuestion).toHaveBeenCalledWith('question-1', [['是']]);
    });
  });

  it('reports Codex runtime not initialized when permission responses are unsupported', async () => {
    const codex = {
      ensure: vi.fn().mockResolvedValue(undefined),
      updatePermissions: vi.fn(),
      sendInput: vi.fn().mockResolvedValue(undefined),
      resetSession: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: codex,
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'codex', cwd: 'D:\\workspace', sessionId: 'codex-session' });
    await dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'codex-session', response: 'once' });

    expect(emit).toHaveBeenCalledWith({
      type: 'sidecar_error',
      error: 'Codex runtime is not initialized',
    });
  });

  it('forwards timeouts to the OpenCode runtime factory on ensure_session', async () => {
    const opencode = createRuntime();
    const createOpenCodeRuntime = vi.fn(() => opencode);
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime,
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-timeouts',
      provider: 'codemux-openai',
      model: 'gpt-5',
      timeouts: { idle_timeout_ms: 60_000, approval_timeout_ms: 0, question_timeout_ms: 15_000 },
    });

    expect(createOpenCodeRuntime).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-timeouts',
      timeouts: { idle_timeout_ms: 60_000, approval_timeout_ms: 0, question_timeout_ms: 15_000 },
    }));
  });

  it('keeps Codex and Claude commands on their existing runtime paths', async () => {
    const claude = createRuntime();
    const codex = createRuntime();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: codex,
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'codex', cwd: 'D:\\workspace', sessionId: 'codex-session' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'codex', sessionId: 'codex-session', permissionConfig: { kind: 'codex', approvalPolicy: 'never' } });
    await dispatcher.dispatch({ type: 'send_input', sessionId: 'codex-session', prompt: 'codex' });
    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'claude_code', cwd: 'D:\\workspace', sessionId: 'claude-session' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'claude_code', sessionId: 'claude-session', permissionConfig: { kind: 'claude_code', permissionMode: 'default' } });
    await dispatcher.dispatch({ type: 'send_input', sessionId: 'claude-session', prompt: 'claude' });

    expect(codex.ensure).toHaveBeenCalledTimes(1);
    expect(codex.updatePermissions).toHaveBeenCalledTimes(1);
    expect(codex.sendInput).toHaveBeenCalledWith('codex', undefined);
    expect(claude.ensure).toHaveBeenCalledTimes(1);
    expect(claude.updatePermissions).toHaveBeenCalledTimes(1);
    expect(claude.sendInput).toHaveBeenCalledWith('claude', undefined);
  });

  it('emits a structured failure when an imported session cannot be restored', async () => {
    const opencode = createRuntime();
    opencode.ensure.mockRejectedValue(new Error('Failed to restore OpenCode session "external-1": session not found'));
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'app-session-1',
      agentSessionId: 'external-1',
      resumeOnly: true,
    });

    expect(emit).toHaveBeenCalledWith({
      type: 'session_resume_failed',
      session_id: 'app-session-1',
      agent_kind: 'opencode',
      agent_session_id: 'external-1',
      error: 'Error: Failed to restore OpenCode session "external-1": session not found',
    });
  });

  it('cleans the previous OpenCode runtime before replacing it', async () => {
    const first = createRuntime();
    const second = createRuntime();
    const createOpenCodeRuntime = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime,
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    const firstEnsure = dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\one', sessionId: 'session-1' });
    const secondEnsure = dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\two', sessionId: 'session-2' });
    await Promise.all([firstEnsure, secondEnsure]);

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.ensure).toHaveBeenCalledTimes(1);
    expect(first.shutdown.mock.invocationCallOrder[0]).toBeLessThan(second.ensure.mock.invocationCallOrder[0]);
  });

  it('reuses the active OpenCode runtime for a duplicate ensure', async () => {
    const opencode = createRuntime();
    opencode.canReuse.mockReturnValue(true);
    const emit = vi.fn();
    const createOpenCodeRuntime = vi.fn(() => opencode);
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime,
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      provider: 'codemux-openai',
      model: 'gpt-5',
      runtimeGeneration: 1,
      planMode: 'on',
    });
    await dispatcher.dispatch({
      type: 'ensure_session',
      agentKind: 'opencode',
      cwd: 'D:\\workspace',
      sessionId: 'session-1',
      agentSessionId: 'opencode-session-1',
      provider: 'codemux-openai',
      model: 'gpt-5',
      runtimeGeneration: 2,
      planMode: 'on',
    });

    expect(createOpenCodeRuntime).toHaveBeenCalledTimes(1);
    expect(opencode.shutdown).not.toHaveBeenCalled();
    expect(opencode.updatePermissions).toHaveBeenCalledWith(expect.objectContaining({ planMode: 'on' }));
    expect(opencode.emitSessionMapping).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runtimeGeneration: 2,
    }));
  });

  it('suppresses abort failures but reports permission failures without stopping dispatch', async () => {
    const opencode = createRuntime();
    opencode.sendInput.mockRejectedValue(new Error('operation was aborted'));
    opencode.interrupt.mockRejectedValue(new Error('AbortError'));
    opencode.respondToPermission.mockRejectedValue(new Error('permission failed'));
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1' });
    await dispatcher.dispatch({ type: 'send_input', prompt: 'hello' });
    await dispatcher.dispatch({ type: 'interrupt' });
    await dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: 'reject' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'opencode', sessionId: 'session-1' });

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({ type: 'sidecar_error', error: 'Error: permission failed' }));
    expect(emit).not.toHaveBeenCalledWith({ type: 'sidecar_error', error: 'Error: operation was aborted' });
    expect(emit).not.toHaveBeenCalledWith({ type: 'sidecar_error', error: 'Error: AbortError' });
  });

  it('shuts down OpenCode even when another agent kind is active', async () => {
    const opencode = createRuntime();
    const claude = createRuntime();
    const stopProxy = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit: vi.fn(),
      stopProxy,
      exit,
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1' });
    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'claude_code', cwd: 'D:\\workspace', sessionId: 'session-2' });
    await dispatcher.dispatch({ type: 'shutdown' });

    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
    expect(stopProxy).toHaveBeenCalledTimes(1);
    expect(claude.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('continues cleanup when proxy shutdown fails', async () => {
    const opencode = createRuntime();
    const claude = createRuntime();
    const emit = vi.fn();
    const exit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockRejectedValue(new Error('proxy stop failed')),
      exit,
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1' });
    await dispatcher.dispatch({ type: 'shutdown' });

    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'sidecar_error',
      error: expect.stringContaining('Failed to stop proxy: Error: proxy stop failed'),
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps the command loop responsive while permission response is pending and deduplicates it', async () => {
    const opencode = createRuntime();
    let resolvePermission!: () => void;
    opencode.respondToPermission.mockReturnValue(new Promise<void>((resolve) => { resolvePermission = resolve; }));
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      createPiRuntime: vi.fn(() => opencode),
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1' });
    const firstResponse = dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: 'always' });
    await vi.waitFor(() => expect(opencode.respondToPermission).toHaveBeenCalledTimes(1));
    const duplicateResponse = dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: 'always' });
    await dispatcher.dispatch({ type: 'interrupt' });
    await dispatcher.dispatch({ type: 'shutdown' });

    expect(opencode.interrupt).toHaveBeenCalledTimes(1);
    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
    expect(opencode.respondToPermission).toHaveBeenCalledTimes(1);
    resolvePermission();
    await Promise.all([firstResponse, duplicateResponse]);
  });

  it('allows the same permission request id after replacing the OpenCode runtime', async () => {
    const first = createRuntime();
    const second = createRuntime();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    first.respondToPermission.mockReturnValue(new Promise<void>((resolve) => { resolveFirst = resolve; }));
    second.respondToPermission.mockReturnValue(new Promise<void>((resolve) => { resolveSecond = resolve; }));
    const createOpenCodeRuntime = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime,
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\one', sessionId: 'session-1' });
    const firstResponse = dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'reused-request', sessionId: 'session-1', response: 'always' });
    await vi.waitFor(() => expect(first.respondToPermission).toHaveBeenCalledTimes(1));
    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\two', sessionId: 'session-2' });
    const secondResponse = dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'reused-request', sessionId: 'session-2', response: 'reject' });
    await vi.waitFor(() => expect(second.respondToPermission).toHaveBeenCalledTimes(1));

    resolveFirst();
    resolveSecond();
    await Promise.all([firstResponse, secondResponse]);
  });

  it('accepts the formal permission response command shape', () => {
    const command: SidecarCommand = {
      type: 'respond_to_permission',
      requestId: 'permission-1',
      sessionId: 'session-1',
      response: 'always',
    };
    expect(command.type).toBe('respond_to_permission');
  });

  it('routes send_input delivery steer to steerActiveTurn and emits user_message plus steer_result', async () => {
    const claude = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'claude_code', cwd: 'D:\\workspace', sessionId: 'session-1' });
    await dispatcher.dispatch({
      type: 'send_input',
      sessionId: 'session-1',
      prompt: 'focus on tests',
      delivery: 'steer',
      requestId: 'steer-1',
    });

    expect(claude.steerActiveTurn).toHaveBeenCalledWith('focus on tests', undefined);
    expect(claude.sendInput).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_message',
      session_id: 'session-1',
      content: 'focus on tests',
    }));
    expect(emit).toHaveBeenCalledWith({ type: 'steer_result', request_id: 'steer-1', ok: true });
  });

  it('emits steer_result unavailable when steerActiveTurn rejects as unavailable', async () => {
    const claude = createRuntime();
    claude.steerActiveTurn.mockRejectedValue(new SteerUnavailableError('no active Claude turn to steer'));
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      createPiRuntime: vi.fn(() => createRuntime()),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'claude_code', cwd: 'D:\\workspace', sessionId: 'session-1' });
    await dispatcher.dispatch({
      type: 'send_input',
      sessionId: 'session-1',
      prompt: 'focus on tests',
      delivery: 'steer',
      requestId: 'steer-2',
    });

    expect(emit).toHaveBeenCalledWith({
      type: 'steer_result',
      request_id: 'steer-2',
      ok: false,
      unavailable: true,
      error: expect.stringContaining('no active Claude turn'),
    });
    expect(claude.sendInput).not.toHaveBeenCalled();
  });
});

/**
 * The warmup wait used to collapse "warmup failed" and "warmup still running"
 * into the same `null`, which made a failing warmup look like a slow one in the
 * daemon log. These tests pin the three distinct outcomes.
 */
describe('waitForWarmup', () => {
  const fakeWarmSession = () => ({ query: vi.fn(), close: vi.fn() }) as never;

  it('returns the warmed session when the warmup settles', async () => {
    const warm = fakeWarmSession();
    await expect(waitForWarmup(Promise.resolve(warm), 1_000)).resolves.toEqual({
      kind: 'ready',
      warm,
    });
  });

  it('reports a settled warmup that produced no reusable session', async () => {
    await expect(waitForWarmup(Promise.resolve(null), 1_000)).resolves.toEqual({
      kind: 'settled_empty',
    });
  });

  it('reports a rejected warmup as settled rather than timing out', async () => {
    await expect(
      waitForWarmup(Promise.reject(new Error('startup() failed')), 1_000),
    ).resolves.toEqual({ kind: 'settled_empty' });
  });

  it('reports a timeout only when the warmup is still pending', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => {});
      const result = waitForWarmup(pending, 2_000);
      await vi.advanceTimersByTimeAsync(1_999);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
