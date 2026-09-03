import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { PiRpcProcess } from './piRpcTransport.js';
import { PiRuntime, buildPiModelsJson, createDefaultPiTransport, writePiModelsJson } from './piRuntime.js';
import type { PiSessionConfig } from './types.js';

const FAKE_PI_PATH = fileURLToPath(new URL('./__fixtures__/fake-pi.mjs', import.meta.url));
const FAKE_SESSION_FILE = path.join(os.tmpdir(), `pi-fake-session-${process.pid}.jsonl`);

type WireMessage = Record<string, unknown>;

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

async function vi_waitFor(condition: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      condition();
      return;
    } catch {
      if (Date.now() - started > timeoutMs) {
        throw new Error('vi_waitFor timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function buildConfig(overrides: Partial<PiSessionConfig> = {}): PiSessionConfig {
  return {
    cwd: os.tmpdir(),
    sessionId: 'app-session-1',
    runtimeGeneration: 0,
    credentialSource: 'none',
    ...overrides,
  };
}

function startFakePiRuntime(
  scenario: WireMessage,
  configOverrides: Partial<PiSessionConfig> = {},
): { runtime: PiRuntime; events: Array<Record<string, unknown>> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-scenario-'));
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8');
  const events: Array<Record<string, unknown>> = [];
  const runtime = new PiRuntime(buildConfig(configOverrides), {
    transportFactory: () =>
      PiRpcProcess.start({
        command: process.execPath,
        args: [FAKE_PI_PATH],
        env: { PI_FAKE_SCENARIO: scenarioFile },
        requestTimeoutMs: 2_000,
      }),
    eventIdFactory: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    emitEvent: (event) => {
      events.push(event as Record<string, unknown>);
    },
  });
  return { runtime, events };
}

describe('PiRuntime', () => {
  it('ensure() spawns pi, reads state and emits the session mapping', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
      },
    });
    try {
      const mapping = await runtime.ensure();
      expect(mapping).toEqual({
        sessionId: 'app-session-1',
        agentSessionId: FAKE_SESSION_FILE,
        runtimeGeneration: 0,
      });
      expect(runtime.isStarted).toBe(true);
      expect(events).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it('sendInput streams projected events and completes on agent_end', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { delayMs: 0, event: { type: 'agent_start' } },
            { delayMs: 0, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } } },
            {
              delayMs: 0,
              event: {
                type: 'message_end',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
              },
            },
            { delayMs: 0, event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      events.length = 0;
      await runtime.sendInput('hello');
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('content_started');
      expect(types).toContain('text_delta');
      expect(types).toContain('assistant_message');
      expect(types[types.length - 1]).toBe('turn_finished');
      expect(events[events.length - 1]).toMatchObject({ type: 'turn_finished', outcome: 'completed' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('marks the turn interrupted after abort()', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        abort: { data: {} },
        prompt: {
          data: {},
          thenEvents: [
            { delayMs: 20, event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      events.length = 0;
      const turn = runtime.sendInput('long task');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.interrupt();
      // 中断正常结束 sendInput：outcome 由 turn_finished 事件携带，不再抛错。
      await turn;
      const finished = events.find((event) => event.type === 'turn_finished');
      expect(finished).toMatchObject({ type: 'turn_finished', outcome: 'interrupted' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('projects process exit as a failed turn with an error event', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [{ delayMs: 10, event: { type: 'agent_start' } }],
          thenExit: { code: 1 },
        },
      },
    });
    try {
      await runtime.ensure();
      events.length = 0;
      await expect(runtime.sendInput('crash me')).rejects.toThrow(/pi process exited/);
      const types = events.map((event) => event.type);
      expect(types).toContain('error');
      expect(types[types.length - 1]).toBe('turn_finished');
      expect(events[events.length - 1]).toMatchObject({ type: 'turn_finished', outcome: 'failed' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('deletes pi session files by path and refuses non-session paths', async () => {
    const sessionFile = path.join(os.tmpdir(), `pi-delete-test-${Date.now()}.jsonl`);
    fs.writeFileSync(sessionFile, '{}\n', 'utf8');
    const { runtime } = startFakePiRuntime({
      responses: { get_state: { data: { sessionId: 'pi-s1', sessionFile } } },
    });
    try {
      await runtime.ensure();
      await runtime.deleteSession(sessionFile);
      expect(fs.existsSync(sessionFile)).toBe(false);
      await expect(runtime.deleteSession('C:/important/file.txt')).rejects.toThrow(/Refusing/);
    } finally {
      await runtime.shutdown();
    }
  });

  describe('credential guardrails (ADR 0005)', () => {
    it('refuses to spawn a codemux session without an API key', async () => {
      const runtime = new PiRuntime(
        buildConfig({ credentialSource: 'codemux', provider: 'anthropic', model: 'claude-x' }),
      );
      await expect(runtime.ensure()).rejects.toThrow(/refusing to fall back/i);
    });

    it('refuses providers that cannot map to environment credentials', async () => {
      const runtime = new PiRuntime(
        buildConfig({
          credentialSource: 'codemux',
          apiKey: 'sk-test',
          provider: 'deepseek',
          model: 'deepseek-chat',
        }),
      );
      await expect(runtime.ensure()).rejects.toThrow(/cannot be mapped/);
    });
  });

  it('attaches per-turn token usage to turn_finished from session stats deltas', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [{ delayMs: 0, event: { type: 'agent_end' } }],
        },
      },
      // 会话累计值：turn 前基线 10/5/2，turn 后 20/9/4 → 差值 10/4/2。
      responseSequences: {
        get_session_stats: [
          { data: { tokens: { input: 10, output: 5, cacheRead: 2 } } },
          { data: { tokens: { input: 20, output: 9, cacheRead: 4 } } },
        ],
      },
    });
    try {
      await runtime.ensure();
      events.length = 0;
      await runtime.sendInput('hi');
      const finished = events.find((event) => event.type === 'turn_finished');
      expect(finished).toMatchObject({
        type: 'turn_finished',
        outcome: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cached_input_tokens: 2,
          reasoning_output_tokens: 0,
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('routes /compact through the native compact RPC without a wall-clock timeout', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        compact: {
          data: {},
          thenEvents: [{ delayMs: 5, event: { type: 'compaction_end', reason: 'manual' } }],
        },
      },
      // 基线 10/5/2 → 压缩后 15/6/2，差值 5/1/0。
      responseSequences: {
        get_session_stats: [
          { data: { tokens: { input: 10, output: 5, cacheRead: 2 } } },
          { data: { tokens: { input: 15, output: 6, cacheRead: 2 } } },
        ],
      },
    });
    try {
      await runtime.ensure();
      events.length = 0;
      await runtime.sendInput('/compact keep the plan section');
      await vi_waitFor(() => expect(events.map((event) => event.type)).toContain('system_event'));
      const finished = events.find((event) => event.type === 'turn_finished');
      expect(finished).toMatchObject({
        type: 'turn_finished',
        outcome: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      });
      const boundary = events.find((event) => event.type === 'system_event');
      expect(boundary).toMatchObject({
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual' },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('forks by copying the native session file to a sibling path', async () => {
    const source = path.join(os.tmpdir(), `pi-fork-source-${Date.now()}.jsonl`);
    fs.writeFileSync(source, '{"type":"session"}\n', 'utf8');
    const { runtime } = startFakePiRuntime({
      responses: { get_state: { data: { sessionId: 'pi-s1', sessionFile: source } } },
    });
    try {
      await runtime.ensure();
      const forkedPath = await runtime.forkSession();
      expect(forkedPath).toContain('-fork-');
      expect(forkedPath.endsWith('.jsonl')).toBe(true);
      expect(fs.existsSync(forkedPath)).toBe(true);
      expect(path.dirname(forkedPath)).toBe(path.dirname(source));
      expect(fs.readFileSync(forkedPath, 'utf8')).toBe('{"type":"session"}\n');
      fs.rmSync(forkedPath, { force: true });
    } finally {
      await runtime.shutdown();
      fs.rmSync(source, { force: true });
    }
  });

  it('re-ensures after a process crash, resuming from the latest session file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-crash-test-'));
    pendingCleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sessionFile = path.join(dir, 'session.jsonl');
    const scenarioFile = path.join(dir, 'scenario.json');
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({
        responses: { get_state: { data: { sessionId: 'pi-s1', sessionFile } } },
      }),
      'utf8',
    );
    const spawnedConfigs: PiSessionConfig[] = [];
    const runtime = new PiRuntime(buildConfig({ credentialSource: 'none' }), {
      transportFactory: (config) => {
        spawnedConfigs.push(config);
        return PiRpcProcess.start({
          command: process.execPath,
          args: [FAKE_PI_PATH],
          env: { PI_FAKE_SCENARIO: scenarioFile },
          requestTimeoutMs: 2_000,
        });
      },
    });
    try {
      await runtime.ensure();
      // 模拟进程崩溃（非主动关闭）。
      (runtime as unknown as { handleProcessExit: (c: number | null, s: NodeJS.Signals | null) => void })
        .handleProcessExit(1, null);
      expect(runtime.isStarted).toBe(false);

      const mapping = await runtime.ensure();
      expect(mapping.agentSessionId).toBe(sessionFile);
      expect(spawnedConfigs).toHaveLength(2);
      // 第二次拉起应携带首次会话文件以便 resume。
      expect(spawnedConfigs[1]?.agentSessionId).toBe(sessionFile);
    } finally {
      await runtime.shutdown();
    }
  });

  describe('pi LLM errors and auto retry', () => {
    const FATAL_ERROR_SCENARIO = {
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          result: {},
          thenEvents: [
            { event: { type: 'agent_start' } },
            { event: { type: 'turn_start' } },
            { event: { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '403 Request not allowed' } } },
            { event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '403 Request not allowed' } } },
            { event: { type: 'turn_end' } },
            { event: { type: 'agent_end' } },
          ],
        },
      },
    };

    it('fails the turn with a visible error for fatal LLM errors (no retry)', async () => {
      const { runtime, events } = startFakePiRuntime(FATAL_ERROR_SCENARIO);
      try {
        await runtime.ensure();
        await expect(runtime.sendInput('hi')).rejects.toThrow(/403 Request not allowed/);
        const errorIndex = events.findIndex((event) => (event as { subtype?: string }).subtype === 'pi_llm_error');
        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        expect((events[errorIndex] as { error?: string }).error).toBe('403 Request not allowed');
        expect(finished).toHaveLength(1);
        expect(finished[0]?.outcome).toBe('failed');
        expect(finished[0]?.reason).toBe('403 Request not allowed');
        // 错误消息不再投影为空 assistant_message 气泡。
        expect(events.some((event) => event.type === 'assistant_message')).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    });

    it('keeps the turn open across auto retry and completes after recovery', async () => {
      const { runtime, events } = startFakePiRuntime({
        responses: {
          get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
          prompt: {
            result: {},
            thenEvents: [
              { event: { type: 'agent_start' } },
              { event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 overloaded' } } },
              { event: { type: 'agent_end' } },
              { event: { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 5, errorMessage: '429 overloaded' } },
              { event: { type: 'agent_start' } },
              { event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } } },
              { event: { type: 'agent_end' } },
              { event: { type: 'auto_retry_end', success: true, attempt: 2 } },
            ],
          },
        },
      });
      try {
        await runtime.ensure();
        await runtime.sendInput('hi');
        await vi_waitFor(() => {
          const errorEvents = events.filter((event) => (event as { subtype?: string }).subtype === 'pi_llm_error');
          if (errorEvents.length > 0) throw new Error('unexpected pi_llm_error');
          const finished = events.filter((event) => event.type === 'turn_finished');
          if (finished.length !== 1) throw new Error('turn not finished exactly once');
          if (finished[0]?.outcome !== 'completed') throw new Error('turn not completed');
        });
        expect(events.some((event) => event.type === 'assistant_message')).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    });

    it('fails the turn with finalError when auto retry gives up', async () => {
      const { runtime, events } = startFakePiRuntime({
        responses: {
          get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
          prompt: {
            result: {},
            thenEvents: [
              { event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded' } } },
              { event: { type: 'agent_end' } },
              { event: { type: 'auto_retry_start', attempt: 3, maxAttempts: 3, delayMs: 5, errorMessage: '529 overloaded' } },
              { event: { type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded_error: Overloaded' } },
            ],
          },
        },
      });
      try {
        await runtime.ensure();
        await expect(runtime.sendInput('hi')).rejects.toThrow(/529 overloaded_error/);
        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(finished).toHaveLength(1);
        expect(finished[0]?.outcome).toBe('failed');
        expect(finished[0]?.reason).toBe('529 overloaded_error: Overloaded');
        expect(events.some((event) => (event as { subtype?: string }).subtype === 'pi_llm_error')).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    });
  });

  it('writes the managed models.json with the CodeMUX endpoint for codemux sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-json-'));
    pendingCleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    writePiModelsJson(dir, {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-test',
      api: 'anthropic-messages',
      modelId: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(written.providers.codemux).toEqual({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-test',
      api: 'anthropic-messages',
      models: [{ id: 'glm-5.3-flash', name: 'glm-5.3-flash', contextWindow: 1_000_000, maxTokens: 128_000 }],
    });
    expect(buildPiModelsJson({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-test',
      api: 'openai-completions',
      modelId: 'glm-5.3-flash',
    })).toContain('"api": "openai-completions"');
  });

  it('createDefaultPiTransport writes models.json into the managed config dir', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-tree-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-dir-'));
    pendingCleanups.push(() => {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    });
    const entry = path.join(runtimeDir, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'process.exit(0);\n', 'utf8');

    createDefaultPiTransport(buildConfig({
      credentialSource: 'codemux',
      provider: 'anthropic',
      model: 'glm-5.3-flash',
      apiKey: 'sk-test',
      baseUrl: 'https://provider.example/v1',
      piConfigDir: configDir,
      runtimeRef: { provider: 'pi', runtimeRoot: runtimeDir, runtimePath: runtimeDir } as never,
    }));
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    expect(written.providers.codemux.api).toBe('anthropic-messages');
    expect(written.providers.codemux.models[0].id).toBe('glm-5.3-flash');
  });
});
