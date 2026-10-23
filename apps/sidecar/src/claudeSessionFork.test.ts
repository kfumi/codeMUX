import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: vi.fn(),
  sdkForkSession: null as null | ((sessionId: string) => Promise<{ sessionId: string }>),
}));

vi.mock('./streamEventBatcher.js', () => ({
  emit: () => {},
  resetStreamEventSequences: () => {},
  syncStreamSessionContext: () => {},
  flushStreamEvents: () => {},
}));

vi.mock('./runtimeLoader.js', () => ({
  loadProviderRuntime: () => ({
    ref: { provider: 'claude_code', runtimePath: '/fake/runtime', runtimeVersion: 'test' },
    nodeModulesPath: '/fake/runtime/node_modules',
    runtimeRequire: () => ({}),
    runtimeImport: async () => ({}),
  }),
  isRuntimeError: () => false,
}));

vi.mock('./claudeExecutable.js', () => ({
  resolveClaudeExecutable: () => '/fake/runtime/claude',
}));

vi.mock('./sdkLoader.js', () => ({
  loadClaudeSdk: async () => ({
    query: (...args: unknown[]) => state.query(...args),
    startup: () => Promise.reject(new Error('warmup disabled in test')),
    getSessionInfo: async () => undefined,
    get forkSession() {
      return state.sdkForkSession ?? undefined;
    },
  }),
}));

import { SessionRuntime } from './index.js';

describe('SessionRuntime Claude fork', () => {
  let runtime: SessionRuntime;

  beforeEach(async () => {
    state.query.mockReset();
    state.sdkForkSession = null;
    runtime = new SessionRuntime();
    await runtime.ensure({
      type: 'ensure_session',
      sessionId: 'app-1',
      agentKind: 'claude_code',
      cwd: process.cwd(),
      agentSessionId: 'sdk-session-1',
      runtimeGeneration: 1,
      runtimeRef: { provider: 'claude_code', runtimePath: '/fake/runtime', runtimeVersion: 'test' },
    } as never);
  });

  afterEach(() => {
    runtime.shutdown();
  });

  it('uses the non-destructive SDK fork without opening a query', async () => {
    state.sdkForkSession = vi.fn().mockResolvedValue({ sessionId: 'forked-session' });

    await expect(runtime.forkSession('staged-session')).resolves.toBe('forked-session');

    expect(state.sdkForkSession).toHaveBeenCalledWith('staged-session');
    // A query here would be a real model turn (the empty-prompt bug).
    expect(state.query).not.toHaveBeenCalled();
  });

  it('falls back to the legacy query on runtimes without SDK forkSession', async () => {
    const close = vi.fn();
    state.query.mockImplementation(() => ({
      close,
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'forked-legacy' };
      },
    }));

    await expect(runtime.forkSession('staged-session')).resolves.toBe('forked-legacy');

    expect(state.query).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
