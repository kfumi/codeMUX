import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const emitted: Array<Record<string, unknown>> = [];
  return { emitted };
});

vi.mock('./streamEventBatcher.js', () => ({
  emit: (event: unknown) => {
    harness.emitted.push(event as Record<string, unknown>);
  },
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

type SdkMessage = Record<string, unknown>;

class FakeQuery {
  prompts: Array<Record<string, unknown>> = [];
  closed = false;
  private queue: SdkMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(promptStream: AsyncIterable<Record<string, unknown>>) {
    void this.drainPromptStream(promptStream);
  }

  private async drainPromptStream(stream: AsyncIterable<Record<string, unknown>>): Promise<void> {
    try {
      for await (const message of stream) {
        this.prompts.push(message);
      }
    } catch {
      // Stream aborted; nothing to record.
    }
  }

  pushMessage(message: SdkMessage): void {
    this.queue.push(message);
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  close(): void {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  interrupt(): Promise<void> {
    this.pushMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted by user' });
    return Promise.resolve();
  }

  mcpServerStatus(): Promise<Array<{ name: string; status: string }>> {
    return Promise.resolve([]);
  }

  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<SdkMessage>> => {
        while (this.queue.length === 0) {
          if (this.closed) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
          });
        }
        return { done: false, value: this.queue.shift()! };
      },
    };
  }
}

const sdkRef = vi.hoisted(() => ({
  current: null as { query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => FakeQuery } | null,
}));

vi.mock('./sdkLoader.js', () => ({
  loadClaudeSdk: async () => ({
    query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => sdkRef.current!.query(args),
    startup: () => Promise.reject(new Error('warmup disabled in test')),
  }),
}));

import { SessionRuntime } from './index.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('SessionRuntime turn artifact summary (claude live path)', () => {
  let runtime: SessionRuntime;
  let query: FakeQuery;

  beforeEach(async () => {
    harness.emitted.length = 0;
    runtime = new SessionRuntime();
    await runtime.ensure({
      type: 'ensure_session',
      sessionId: 'app-1',
      agentKind: 'claude_code',
      cwd: process.cwd(),
      runtimeGeneration: 1,
      runtimeRef: { provider: 'claude_code', runtimePath: '/fake/runtime', runtimeVersion: 'test' },
    } as never);
    sdkRef.current = {
      query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => {
        query = new FakeQuery(args.prompt);
        return query;
      },
    };
  });

  afterEach(() => {
    // 收尾必须放在 afterEach:断言失败时测试体提前退出,否则 runtime 泄漏。
    runtime.shutdown();
    vi.restoreAllMocks();
  });

  it('emits session_summary before turn_finished when a turn edits a file', async () => {
    await runtime.sendInput('edit the file');
    await flush();

    query.pushMessage({
      type: 'assistant',
      uuid: 'assistant-edit-1',
      session_id: 'native-1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_edit_1',
            name: 'Edit',
            input: {
              file_path: 'D:/tmp/demo/src/app.ts',
              old_string: 'alpha',
              new_string: 'ALPHA',
            },
          },
        ],
      },
    });
    query.pushMessage({
      type: 'user',
      session_id: 'native-1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_edit_1', content: 'ok' },
        ],
      },
    });
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await flush();

    const summaryIndex = harness.emitted.findIndex(
      (event) => event.type === 'system_event' && event.subtype === 'session_summary',
    );
    const turnFinishedIndex = harness.emitted.findIndex((event) => event.type === 'turn_finished');
    expect(summaryIndex, 'an edit turn must emit a session_summary').toBeGreaterThanOrEqual(0);
    expect(turnFinishedIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(turnFinishedIndex);

    const summary = harness.emitted[summaryIndex] as { diffs?: Array<Record<string, unknown>> };
    expect(summary.diffs).toHaveLength(1);
    expect(summary.diffs?.[0]?.file).toBe('D:/tmp/demo/src/app.ts');
    expect(summary.diffs?.[0]?.additions).toBe(1);
    expect(summary.diffs?.[0]?.deletions).toBe(1);
  });
});
