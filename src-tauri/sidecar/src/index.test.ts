import { describe, expect, it, vi } from 'vitest';
import type { SidecarCommand } from './types.js';
import { createSidecarCommandDispatcher } from './index.js';

function createRuntime() {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    updatePermissions: vi.fn(),
    sendInput: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockResolvedValue(undefined),
  };
}

describe('sidecar command dispatcher', () => {
  it('routes OpenCode lifecycle commands and permission responses', async () => {
    const opencode = createRuntime();
    const emit = vi.fn();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: createRuntime(),
      codexRuntime: createRuntime(),
      createOpenCodeRuntime: vi.fn(() => opencode),
      emit,
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace', sessionId: 'session-1', provider: 'openai', model: 'gpt-5' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'opencode', sessionId: 'session-1', permissionConfig: { mode: 'default' } });
    await dispatcher.dispatch({ type: 'send_input', prompt: 'hello' });
    await dispatcher.dispatch({ type: 'reset_session', sessionId: 'session-1' });
    await dispatcher.dispatch({ type: 'interrupt' });
    await dispatcher.dispatch({ type: 'tool_response', toolUseId: 'tool-1', response: { approved: true } });
    await dispatcher.dispatch({ type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: { approved: true } });

    expect(opencode.ensure).toHaveBeenCalledTimes(1);
    expect(opencode.updatePermissions).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_permissions',
      agentKind: 'opencode',
      sessionId: 'session-1',
    }));
    expect(opencode.sendInput).toHaveBeenCalledWith('hello', undefined);
    expect(opencode.resetSession).toHaveBeenCalledWith('session-1');
    expect(opencode.interrupt).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'sidecar_error',
      error: 'OpenCode tool responses are server-managed/not supported',
    });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'opencode', sessionId: 'session-1', planMode: 'on' });
    expect(opencode.updatePermissions).toHaveBeenCalledTimes(2);
    expect(opencode.respondToPermission).toHaveBeenCalledWith('permission-1', { approved: true }, 'session-1');
  });

  it('keeps Codex and Claude commands on their existing runtime paths', async () => {
    const claude = createRuntime();
    const codex = createRuntime();
    const dispatcher = createSidecarCommandDispatcher({
      claudeRuntime: claude,
      codexRuntime: codex,
      createOpenCodeRuntime: vi.fn(() => createRuntime()),
      emit: vi.fn(),
      stopProxy: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    });

    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'codex', cwd: 'D:\\workspace', sessionId: 'codex-session' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'codex', sessionId: 'codex-session', permissionConfig: { kind: 'codex', approvalPolicy: 'never' } });
    await dispatcher.dispatch({ type: 'send_input', prompt: 'codex' });
    await dispatcher.dispatch({ type: 'ensure_session', agentKind: 'claude_code', cwd: 'D:\\workspace', sessionId: 'claude-session' });
    await dispatcher.dispatch({ type: 'update_permissions', agentKind: 'claude_code', sessionId: 'claude-session', permissionConfig: { kind: 'claude_code', permissionMode: 'default' } });
    await dispatcher.dispatch({ type: 'send_input', prompt: 'claude' });

    expect(codex.ensure).toHaveBeenCalledTimes(1);
    expect(codex.updatePermissions).toHaveBeenCalledTimes(1);
    expect(codex.sendInput).toHaveBeenCalledWith('codex', undefined);
    expect(claude.ensure).toHaveBeenCalledTimes(1);
    expect(claude.updatePermissions).toHaveBeenCalledTimes(1);
    expect(claude.sendInput).toHaveBeenCalledWith('claude', undefined);
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

  it('accepts the formal permission response command shape', () => {
    const command: SidecarCommand = {
      type: 'respond_to_permission',
      requestId: 'permission-1',
      sessionId: 'session-1',
      response: 'always',
    };
    expect(command.type).toBe('respond_to_permission');
  });
});
