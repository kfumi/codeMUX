import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  lastOptions: { current: null as Record<string, unknown> | null },
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
    query: (args: { options?: Record<string, unknown> }) => {
      harness.lastOptions.current = args.options ?? null;
      return {
        // 立即结束：本测试只断言发给 SDK 的 options。
        async *[Symbol.asyncIterator]() {},
      };
    },
    startup: () => Promise.reject(new Error('warmup disabled in test')),
  }),
}));

import { SessionRuntime } from './index.js';

const ensureCommand = (overrides: Record<string, unknown> = {}) => ({
  type: 'ensure_session',
  sessionId: 'app-claude-additional-dirs',
  agentKind: 'claude_code',
  cwd: process.cwd(),
  runtimeGeneration: 1,
  runtimeRef: { provider: 'claude_code', runtimePath: '/fake/runtime', runtimeVersion: 'test' },
  ...overrides,
});

describe('Claude additional directory injection', () => {
  it('appends the directory list to the system prompt without native multi-directory options', async () => {
    harness.lastOptions.current = null;
    const runtime = new SessionRuntime();
    try {
      await runtime.ensure(ensureCommand({
        additionalDirectories: ['D:/work/backend', 'D:/work/shared'],
      }) as never);
      await runtime.sendInput('hello');

      const options = harness.lastOptions.current;
      expect(options).not.toBeNull();
      const systemPrompt = options?.systemPrompt as { type?: string; append?: string } | undefined;
      expect(systemPrompt?.type).toBe('preset');
      expect(systemPrompt?.append).toContain('Additional directories (outside the working directory):');
      expect(systemPrompt?.append).toContain('  - D:/work/backend');
      expect(systemPrompt?.append).toContain('  - D:/work/shared');
      expect(options?.additionalDirectories).toBeUndefined();
      expect(options?.['--add-dir']).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps the append empty when there are no additional directories', async () => {
    harness.lastOptions.current = null;
    const runtime = new SessionRuntime();
    try {
      await runtime.ensure(ensureCommand() as never);
      await runtime.sendInput('hello');

      const systemPrompt = harness.lastOptions.current?.systemPrompt as { append?: string } | undefined;
      expect(systemPrompt?.append).toBe('');
    } finally {
      await runtime.shutdown();
    }
  });
});
