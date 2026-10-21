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
  generatedTitles: Array<{ description: string; persist?: boolean }> = [];
  /** undefined => no generator on this query (old Runtime). */
  titleToGenerate: string | null | undefined = undefined;
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

  mcpServerStatus(): Promise<Array<{ name: string; status: string }>> {
    return Promise.resolve([]);
  }

  /** Only present when this fake models a Runtime that supports title generation. */
  generateSessionTitle?: (
    description: string,
    options?: { persist?: boolean },
  ) => Promise<string | null | undefined>;

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

// `getSessionInfo` is a module-level SDK export (NOT a Query method); the
// runtime must read it off the loaded SDK module. `queryRef` deliberately has
// no `getSessionInfo` so a regression back to `queryHandle.getSessionInfo`
// would emit nothing.
const state = vi.hoisted(() => ({
  queryRef: { current: null as { query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => FakeQuery } | null },
  getSessionInfoRef: { current: null as null | ((sessionId: string) => Promise<unknown>) },
  getSessionInfoCalls: [] as string[],
  generatedTitles: [] as Array<{ description: string; persist?: boolean }>,
  /** null => the fake Runtime exposes no generateSessionTitle. */
  titleGenerator: { current: null as null | ((description: string) => Promise<string | null | undefined>) },
}));

vi.mock('./sdkLoader.js', () => ({
  loadClaudeSdk: async () => ({
    query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => state.queryRef.current!.query(args),
    startup: () => Promise.reject(new Error('warmup disabled in test')),
    getSessionInfo: (sessionId: string) => {
      state.getSessionInfoCalls.push(sessionId);
      return state.getSessionInfoRef.current
        ? state.getSessionInfoRef.current(sessionId)
        : Promise.resolve(undefined);
    },
  }),
}));

import { SessionRuntime } from './index.js';
import { extractClaudeSessionTitle } from './sessionTitleEvent.js';

function titleEvents(): Array<Record<string, unknown>> {
  return harness.emitted.filter((event) => event.type === 'agent_session_title');
}

describe('SessionRuntime native Claude title sync', () => {
  let runtime: SessionRuntime;
  let query: FakeQuery;

  beforeEach(async () => {
    harness.emitted.length = 0;
    state.getSessionInfoCalls.length = 0;
    state.generatedTitles.length = 0;
    state.getSessionInfoRef.current = null;
    state.titleGenerator.current = null;
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
    state.queryRef.current = {
      query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => {
        query = new FakeQuery(args.prompt);
        // A Runtime without a title generator leaves the method off the query.
        if (state.titleGenerator.current) {
          query.generateSessionTitle = async (description, options) => {
            state.generatedTitles.push({ description, ...(options?.persist !== undefined ? { persist: options.persist } : {}) });
            return state.titleGenerator.current!(description);
          };
        }
        return query;
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.shutdown();
  });

  it('asks the CLI to generate and persist a title, then emits it', async () => {
    vi.useFakeTimers();
    state.titleGenerator.current = async () => '  清理三个 worktree  ';

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(10);

    expect(state.generatedTitles).toEqual([{ description: 'first prompt', persist: true }]);
    expect(titleEvents()).toEqual([
      {
        type: 'agent_session_title',
        app_session_id: 'app-1',
        agent_kind: 'claude_code',
        title: '清理三个 worktree',
      },
    ]);
    // Generation succeeded, so the getSessionInfo fallback is never needed.
    expect(state.getSessionInfoCalls).toEqual([]);
  });

  it('falls back to getSessionInfo().summary when the Runtime cannot generate titles', async () => {
    vi.useFakeTimers();
    state.getSessionInfoRef.current = async () => ({ summary: '  Native AI title  ' });

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(4_100);

    expect(state.generatedTitles).toEqual([]);
    expect(state.getSessionInfoCalls).toEqual(['sdk-session-1']);
    expect(titleEvents()).toEqual([
      {
        type: 'agent_session_title',
        app_session_id: 'app-1',
        agent_kind: 'claude_code',
        title: 'Native AI title',
      },
    ]);
  });

  it('falls back when title generation returns nothing', async () => {
    vi.useFakeTimers();
    state.titleGenerator.current = async () => null;
    state.getSessionInfoRef.current = async () => ({ summary: 'Fallback title' });

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(10);

    expect(state.generatedTitles).toEqual([{ description: 'first prompt', persist: true }]);
    expect(titleEvents()).toEqual([
      {
        type: 'agent_session_title',
        app_session_id: 'app-1',
        agent_kind: 'claude_code',
        title: 'Fallback title',
      },
    ]);
  });

  it('stays silent when neither generation nor getSessionInfo yields a title', async () => {
    vi.useFakeTimers();
    state.titleGenerator.current = async () => null;
    state.getSessionInfoRef.current = async () => undefined;

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(12_100);

    expect(state.generatedTitles).toEqual([{ description: 'first prompt', persist: true }]);
    expect(titleEvents()).toEqual([]);
  });

  it('ignores the first-prompt fallback and still picks up the ai-title written after the result', async () => {
    vi.useFakeTimers();
    let info: Record<string, unknown> = {
      summary: 'first prompt',
      firstPrompt: 'first prompt',
    };
    state.getSessionInfoRef.current = async () => info;

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(4_100);

    // 首轮同步时 ai-title 还没落盘：summary 只是首条消息，不能当成原生标题。
    expect(titleEvents()).toEqual([]);

    // CLI 在 result 之后才写 ai-title，阶梯重试把它捡回来。
    info = { summary: '清理三个 worktree', firstPrompt: 'first prompt' };
    await vi.advanceTimersByTimeAsync(8_000);

    expect(titleEvents()).toEqual([
      {
        type: 'agent_session_title',
        app_session_id: 'app-1',
        agent_kind: 'claude_code',
        title: '清理三个 worktree',
      },
    ]);
  });

  it('generates the title only once per session, even after more results', async () => {
    vi.useFakeTimers();
    state.titleGenerator.current = async () => 'Once only';

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(10);

    expect(state.generatedTitles).toEqual([{ description: 'first prompt', persist: true }]);
    expect(titleEvents()).toHaveLength(1);
  });

  it('cancels the retry ladder when the session is reconfigured', async () => {
    vi.useFakeTimers();
    state.getSessionInfoRef.current = async () => ({ summary: 'Stale title' });

    await runtime.sendInput('first prompt');
    await vi.advanceTimersByTimeAsync(10);
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await vi.advanceTimersByTimeAsync(1_000);

    // Reconfigure tears the query down and must drop the pending 4/12/30/60s reads.
    await runtime.shutdown();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(state.getSessionInfoCalls).toEqual([]);
    expect(titleEvents()).toEqual([]);
  });
});

describe('extractClaudeSessionTitle', () => {
  it('prefers a custom title over the summary', () => {
    expect(extractClaudeSessionTitle({
      customTitle: '  我的标题  ',
      summary: 'ai title',
      firstPrompt: 'first prompt',
    })).toBe('我的标题');
  });

  it('drops a summary that is only the first prompt', () => {
    expect(extractClaudeSessionTitle({
      summary: '都可以清理，三个 worktree 都没有独有的提交',
      firstPrompt: '都可以清理，三个 worktree 都没有独有的提交，也没有未提交的改动',
    })).toBeUndefined();
  });

  it('drops a truncated first-prompt summary', () => {
    expect(extractClaudeSessionTitle({
      summary: '使用两个子智能体总结下当前项目的技',
      firstPrompt: '使用两个子智能体总结下当前项目的技术栈',
    })).toBeUndefined();
  });

  it('keeps a real ai-title even when a first prompt exists', () => {
    expect(extractClaudeSessionTitle({
      summary: '清理 chatty-buffalo 等三个 worktree',
      firstPrompt: '都可以清理，三个 worktree 都没有独有的提交',
    })).toBe('清理 chatty-buffalo 等三个 worktree');
  });
});
