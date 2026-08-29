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
  interrupted = 0;
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
    this.interrupted += 1;
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

const harness2 = vi.hoisted(() => ({
  sdkRef: { current: null as { query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => FakeQuery } | null },
  lastQueryOptions: { current: null as Record<string, unknown> | null },
}));

vi.mock('./sdkLoader.js', () => ({
  loadClaudeSdk: async () => ({
    query: (args: { prompt: AsyncIterable<Record<string, unknown>> }) => harness2.sdkRef.current!.query(args),
    startup: () => Promise.reject(new Error('warmup disabled in test')),
  }),
}));

import { SessionRuntime } from './index.js';
import type { CodeMuxSubagentUpsertEvent } from './codeMuxProtocol.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};


function upsertEvents(): CodeMuxSubagentUpsertEvent[] {
  return harness.emitted.filter((event) => event.type === 'subagent_upsert') as CodeMuxSubagentUpsertEvent[];
}

describe('SessionRuntime subagent query lifecycle', () => {
  let runtime: SessionRuntime;
  let query: FakeQuery;

  const ensure = async (overrides: Record<string, unknown> = {}): Promise<void> => {
    await runtime.ensure({
      type: 'ensure_session',
      sessionId: 'app-1',
      agentKind: 'claude_code',
      cwd: process.cwd(),
      runtimeGeneration: 1,
      runtimeRef: { provider: 'claude_code', runtimePath: '/fake/runtime', runtimeVersion: 'test' },
      ...overrides,
    } as never);
  };

  /** Install a fake SDK query that records the options CodeMUX passes to query(). */
  const installFakeSdk = (): void => {
    harness2.sdkRef.current = {
      query: (args: { prompt: AsyncIterable<Record<string, unknown>>; options?: Record<string, unknown> }) => {
        harness2.lastQueryOptions.current = args.options ?? null;
        query = new FakeQuery(args.prompt);
        return query;
      },
    };
  };

  beforeEach(async () => {
    harness.emitted.length = 0;
    runtime = new SessionRuntime();
    await ensure();
    query = new FakeQuery({ [Symbol.asyncIterator]: async function* () {} } as never);
    installFakeSdk();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the query open after the parent result and reuses it for the next turn', async () => {
    await runtime.sendInput('first prompt');
    await flush();
    expect(query.prompts).toHaveLength(1);

    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await flush();
    expect(query.closed).toBe(false);

    await runtime.sendInput('second prompt');
    await flush();
    // The second prompt was pushed into the SAME query's stream.
    expect(query.prompts).toHaveLength(2);
    expect(query.closed).toBe(false);

    runtime.shutdown();
  });

  it('does not close the query for a new turn while a backgrounded child is running', async () => {
    await runtime.sendInput('launch agent');
    await flush();

    query.pushMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'toolu_1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      prompt: 'explore',
    });
    query.pushMessage({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true } });
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'launched' });
    await flush();

    expect(query.closed).toBe(false);
    expect(upsertEvents().some((event) => event.status === 'running')).toBe(true);

    await runtime.sendInput('did it finish?');
    await flush();
    expect(query.prompts).toHaveLength(2);
    expect(query.closed).toBe(false);
    expect(upsertEvents().some((event) => event.status === 'canceled')).toBe(false);

    runtime.shutdown();
  });

  it('cancels explicitly-foreground children on result and keeps backgrounded ones running', async () => {
    await runtime.sendInput('launch two');
    await flush();

    query.pushMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'toolu_1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      prompt: 'foreground',
    });
    query.pushMessage({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: false } });
    query.pushMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-2',
      tool_use_id: 'toolu_2',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      prompt: 'background',
    });
    query.pushMessage({ type: 'system', subtype: 'task_updated', task_id: 'task-2', patch: { is_backgrounded: true } });
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'launched' });
    await flush();

    const statuses = Object.fromEntries(upsertEvents()
      .filter((event) => event.status)
      .map((event) => [event.subagent_id, event.status]));
    expect(statuses).toEqual({ toolu_1: 'canceled', toolu_2: 'running' });

    runtime.shutdown();
  });

  it('fails all running children on user stop', async () => {
    await runtime.sendInput('launch agent');
    await flush();

    query.pushMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'toolu_1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      prompt: 'explore',
    });
    await flush();

    await runtime.interrupt();
    await flush();

    expect(query.interrupted).toBe(1);
    expect(upsertEvents().some((event) => event.status === 'failed')).toBe(true);
    // User Stop ends the whole query; the next turn opens a fresh one.
    expect(query.closed).toBe(true);

    runtime.shutdown();
  });

  it('projects a notification-woken continuation turn arriving between parent turns', async () => {
    await runtime.sendInput('launch agent');
    await flush();
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'launched' });
    await flush();
    const emittedAfterFirstTurn = harness.emitted.length;

    // A task notification wakes the model: assistant content + a result arrive
    // while the parent turn is already over.
    query.pushMessage({
      type: 'assistant',
      uuid: 'assistant-continuation',
      session_id: 'native-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'All three subagents completed, here is the summary' }] },
    });
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'summary done' });
    await flush();

    const kinds = harness.emitted.slice(emittedAfterFirstTurn).map((event) => event.type);
    expect(kinds).toContain('assistant_message');
    expect(kinds).toContain('turn_finished');
    const summary = harness.emitted.find((event) => event.type === 'assistant_message') as { content?: Array<{ text?: string }> } | undefined;
    expect(JSON.stringify(summary?.content)).toContain('summary');

    runtime.shutdown();
  });

  it('synthesizes turn_finished when a continuation turn goes quiet without a CLI result', async () => {
    runtime.continuationQuiescenceMs = 250;
    await runtime.sendInput('launch agent');
    await flush();
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'launched' });
    await flush();
    const emittedAfterFirstTurn = harness.emitted.length;

    // A task notification wakes the model, but the CLI never sends a result
    // for the woken turn (observed with gateway providers).
    query.pushMessage({
      type: 'assistant',
      uuid: 'assistant-continuation',
      session_id: 'native-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'All subagents completed, here is the summary' }] },
    });
    await flush();
    expect(harness.emitted.slice(emittedAfterFirstTurn).some((event) => event.type === 'turn_finished')).toBe(false);

    // Silence past the quiescence window closes the turn explicitly.
    await new Promise((resolve) => setTimeout(resolve, 450));
    const finish = harness.emitted
      .slice(emittedAfterFirstTurn)
      .find((event) => event.type === 'turn_finished') as { outcome?: string } | undefined;
    expect(finish?.outcome).toBe('completed');

    runtime.shutdown();
  });

  it('closes a pending continuation turn before pushing the next prompt', async () => {
    runtime.continuationQuiescenceMs = 60_000;
    await runtime.sendInput('launch agent');
    await flush();
    query.pushMessage({ type: 'result', subtype: 'success', is_error: false, result: 'launched' });
    await flush();

    query.pushMessage({
      type: 'assistant',
      uuid: 'assistant-continuation',
      session_id: 'native-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Frontend done, waiting for backend' }] },
    });
    await flush();
    expect(harness.emitted.some((event) => event.type === 'turn_finished')).toBe(true);
    const finishesAfterContent = harness.emitted.filter((event) => event.type === 'turn_finished');
    expect(finishesAfterContent).toHaveLength(1);

    await runtime.sendInput('summarize now');
    await flush();
    // The pending continuation was closed before the new prompt turn started.
    expect(harness.emitted.filter((event) => event.type === 'turn_finished')).toHaveLength(2);
    expect(query.prompts).toHaveLength(2);
    expect(query.closed).toBe(false);

    runtime.shutdown();
  });

  it('pins CLI model-alias env vars to the session model for gateway sessions', async () => {
    runtime = new SessionRuntime();
    await ensure({ model: 'glm-5.3-flash', baseUrl: 'https://gateway.example/anthropic', apiKey: 'k' });
    installFakeSdk();

    await runtime.sendInput('hello');
    await flush();

    const env = harness2.lastQueryOptions.current?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('glm-5.3-flash');

    runtime.shutdown();
  });

  it('leaves model-alias env untouched for direct Anthropic sessions', async () => {
    runtime = new SessionRuntime();
    await ensure({ model: 'claude-sonnet-4-5' });
    installFakeSdk();

    await runtime.sendInput('hello');
    await flush();

    const env = harness2.lastQueryOptions.current?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '').toBe('');

    runtime.shutdown();
  });
});
