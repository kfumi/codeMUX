import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { PiRpcProcess } from './piRpcTransport.js';
import { PI_APPROVE_TITLE_PREFIX, PI_ASK_TITLE_PREFIX } from './piExtension.js';
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
): { runtime: PiRuntime; events: Array<Record<string, unknown>>; wireLog: () => Array<WireMessage> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-scenario-'));
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8');
  const wireLogFile = path.join(dir, 'wire.log');
  const events: Array<Record<string, unknown>> = [];
  const runtime = new PiRuntime(buildConfig(configOverrides), {
    transportFactory: () =>
      PiRpcProcess.start({
        command: process.execPath,
        args: [FAKE_PI_PATH],
        env: { PI_FAKE_SCENARIO: scenarioFile, PI_FAKE_LOG: wireLogFile },
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
  pendingCleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wireLog = (): Array<WireMessage> =>
    fs.existsSync(wireLogFile)
      ? fs
        .readFileSync(wireLogFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { direction: string; message: WireMessage })
        .map((entry) => entry.message)
      : [];
  return { runtime, events, wireLog };
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
      // turn_finished 携带真实耗时（缺失会被前端映射成 duration_ms: 0）。
      const durationMs = (events[events.length - 1] as { duration_ms?: number }).duration_ms;
      expect(typeof durationMs === 'number' && durationMs >= 0).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it('marks the turn interrupted after abort()', async () => {
    const { runtime, events, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        abort: { data: {} },
        prompt: {
          data: {},
          // agent_end 缓存到收到 abort 才放行：中断标记一定先于 agent_end。
          holdUntilAbort: true,
          thenEvents: [
            { delayMs: 5, event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      const turn = runtime.sendInput('long task');
      // 等 prompt 受理回执再中断：pendingTurn 在受理之前才赋值（前面还有一次
      // get_session_stats 往返），负载下过早中断会丢 interrupted 标记。
      await vi_waitFor(() => {
        if (!wireLog().some((message) => message.type === 'response' && message.command === 'prompt')) {
          throw new Error('prompt not acknowledged yet');
        }
      });
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

describe('PiRuntime interactive extension bridge', () => {
  function approveTitle(toolCallId: string, toolName: string): string {
    return PI_APPROVE_TITLE_PREFIX + JSON.stringify({ toolCallId, toolName });
  }

  function askTitle(toolCallId: string, index: number): string {
    return PI_ASK_TITLE_PREFIX + JSON.stringify({ toolCallId, index });
  }

  function waitForEvent(events: Array<Record<string, unknown>>, type: string): void {
    return vi_waitFor(() => {
      if (events.find((event) => event.type === type) === undefined) {
        throw new Error(`${type} not emitted yet`);
      }
    });
  }

  it('bridges an approval dialog: permission_requested then extension_ui_response', async () => {
    const { runtime, events, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } } },
            {
              event: {
                type: 'extension_ui_request',
                id: 'ext-1',
                method: 'select',
                title: approveTitle('t1', 'bash'),
                options: ['Allow', 'Always allow', 'Reject'],
              },
              awaitResponse: true,
            },
            { event: { type: 'tool_execution_end', toolCallId: 't1', result: 'ok', isError: false } },
            { event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      const turn = runtime.sendInput('run ls');
      await waitForEvent(events, 'permission_requested');
      expect(events.find((event) => event.type === 'permission_requested')).toMatchObject({
        request_id: 'ext-1',
        permission_type: 'bash',
        metadata: { toolName: 'bash', input: { command: 'ls -la' } },
      });
      await runtime.respondToPermission('ext-1', 'once', 'app-session-1');
      await turn;
      const response = wireLog().find((message) => message.type === 'extension_ui_response');
      expect(response).toMatchObject({ id: 'ext-1', value: 'Allow' });
      expect(events.find((event) => event.type === 'permission_resolved')).toMatchObject({
        request_id: 'ext-1',
        request_kind: 'permission',
      });
      const finished = events.find((event) => event.type === 'turn_finished');
      expect(finished).toMatchObject({ type: 'turn_finished', outcome: 'completed' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('maps reject responses onto the extension select choice', async () => {
    const { runtime, events, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: {} } },
            {
              event: {
                type: 'extension_ui_request',
                id: 'ext-2',
                method: 'select',
                title: approveTitle('t1', 'write'),
              },
              awaitResponse: true,
            },
            { event: { type: 'tool_execution_end', toolCallId: 't1', result: 'blocked', isError: true } },
            { event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      const turn = runtime.sendInput('write file');
      await waitForEvent(events, 'permission_requested');
      await runtime.respondToPermission('ext-2', 'reject', 'app-session-1');
      await turn;
      const response = wireLog().find((message) => message.type === 'extension_ui_response');
      expect(response).toMatchObject({ id: 'ext-2', value: 'Reject' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('combines sequential ask dialogs into one user_input_requested card', async () => {
    const questions = [
      { question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] },
      { question: '补充说明' },
    ];
    const { runtime, events, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { event: { type: 'tool_execution_start', toolCallId: 'a1', toolName: 'ask_user_question', args: { questions } } },
            {
              event: { type: 'extension_ui_request', id: 'ask-0', method: 'select', title: askTitle('a1', 0) },
              awaitResponse: true,
            },
            {
              event: { type: 'extension_ui_request', id: 'ask-1', method: 'input', title: askTitle('a1', 1) },
              awaitResponse: true,
            },
            { event: { type: 'tool_execution_end', toolCallId: 'a1', result: 'done', isError: false } },
            { event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      expect(runtime.isPendingQuestion('a1')).toBe(false);
      const turn = runtime.sendInput('ask me');
      await waitForEvent(events, 'user_input_requested');
      expect(runtime.isPendingQuestion('a1')).toBe(true);
      expect(events.find((event) => event.type === 'user_input_requested')).toMatchObject({
        tool_use_id: 'a1',
        questions: [
          { question: '选择方案', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
          { question: '补充说明', options: [], multiSelect: false },
        ],
      });
      await runtime.respondToQuestion('a1', [['B'], ['补充文字']]);
      await turn;
      const responses = wireLog().filter((message) => message.type === 'extension_ui_response');
      expect(responses.map((message) => ({ id: message.id, value: message.value }))).toEqual([
        { id: 'ask-0', value: 'B' },
        { id: 'ask-1', value: '补充文字' },
      ]);
      expect(events.find((event) => event.type === 'permission_resolved')).toMatchObject({
        request_id: 'a1',
        request_kind: 'question',
      });
      expect(runtime.isPendingQuestion('a1')).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it('cancels dialogs from unknown extensions instead of hanging', async () => {
    const { runtime, events, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { event: { type: 'extension_ui_request', id: 'foreign-1', method: 'select', title: '第三方扩展对话框' } },
            { event: { type: 'agent_end' } },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      await runtime.sendInput('hello');
      await vi_waitFor(() => {
        if (wireLog().find((message) => message.type === 'extension_ui_response') === undefined) {
          throw new Error('extension_ui_response not sent yet');
        }
      });
      const response = wireLog().find((message) => message.type === 'extension_ui_response');
      expect(response).toMatchObject({ id: 'foreign-1', cancelled: true });
      expect(events.find((event) => event.type === 'permission_requested')).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it('cancels pending requests on shutdown and dismisses the card', async () => {
    const { runtime, events } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          thenEvents: [
            { event: { type: 'tool_execution_start', toolCallId: 't9', toolName: 'bash', args: {} } },
            {
              event: {
                type: 'extension_ui_request',
                id: 'ext-9',
                method: 'select',
                title: approveTitle('t9', 'bash'),
              },
              awaitResponse: true,
            },
          ],
        },
      },
    });
    try {
      await runtime.ensure();
      // 预挂 catch：shutdown 会 reject 挂起的 sendInput，避免未处理拒绝告警。
      const turn = runtime.sendInput('run').catch(() => undefined);
      await waitForEvent(events, 'permission_requested');
      await runtime.shutdown();
      await turn;
      expect(events.find((event) => event.type === 'permission_resolved')).toMatchObject({
        request_id: 'ext-9',
        request_kind: 'permission',
      });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it('rebuilds the process when the approval mode changes (canReuse)', async () => {
    const { runtime } = startFakePiRuntime(
      {
        responses: {
          get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        },
      },
      { approvalMode: 'confirm_before_edit' },
    );
    try {
      await runtime.ensure();
      expect(runtime.canReuse(buildConfig({ approvalMode: 'confirm_before_edit' }))).toBe(true);
      expect(runtime.canReuse(buildConfig({ approvalMode: 'full_access' }))).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('PiRuntime session-tree rewind', () => {
  it('forks to an entry and adopts the new session file in-process', async () => {
    const forkedSessionFile = path.join(os.tmpdir(), `pi-fake-session-forked-${process.pid}.jsonl`);
    const { runtime, wireLog } = startFakePiRuntime({
      responseSequences: {
        // 第一次 ensure 回读旧文件；fork 后的 get_state 回读 branched 新文件。
        get_state: [
          { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
          { data: { sessionId: 'pi-s2', sessionFile: forkedSessionFile } },
        ],
      },
      responses: {
        fork: { data: { text: 'retry prompt', cancelled: false } },
      },
    });
    try {
      const before = await runtime.ensure();
      expect(before.agentSessionId).toBe(FAKE_SESSION_FILE);

      const forked = await runtime.forkToEntry('u-entry-1');
      expect(forked).toBe(forkedSessionFile);
      expect(wireLog().some((m) => m.type === 'fork' && m.entryId === 'u-entry-1')).toBe(true);

      // 进程内 rebind：不重建子进程，ensure 复用并回报新 mapping；
      // canReuse 以新会话文件比对（宿主更新 mapping 后不会误触发重建）。
      const after = await runtime.ensure();
      expect(after.agentSessionId).toBe(forkedSessionFile);
      expect(runtime.canReuse(buildConfig({ agentSessionId: forkedSessionFile }))).toBe(true);
      expect(runtime.canReuse(buildConfig())).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects rewind while a turn is running', async () => {
    const { runtime, wireLog } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
        prompt: {
          data: {},
          // 中断时序测试：agent_end 缓存到收到 abort 再放行，turn 可确定性收尾。
          holdUntilAbort: true,
          thenEvents: [{ delayMs: 0, event: { type: 'agent_end' } }],
        },
      },
      responseSequences: {
        fork: [{ data: { text: '', cancelled: false } }],
      },
    });
    try {
      await runtime.ensure();
      // 预挂 catch：interrupt 正常收尾 sendInput。
      const turn = runtime.sendInput('long task').catch(() => undefined);
      await vi_waitFor(() => {
        if (!wireLog().some((m) => m.type === 'prompt')) {
          throw new Error('prompt not sent yet');
        }
      });
      await expect(runtime.forkToEntry('u-entry-1')).rejects.toThrow(/still running/i);
      await runtime.interrupt();
      await turn;
      // turn 结束后 rewind 恢复可用（不残留 pendingTurn 误拒）。
      const forked = await runtime.forkToEntry('u-entry-1');
      expect(typeof forked).toBe('string');
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it('surfaces cancelled forks and pi RPC errors', async () => {
    const { runtime } = startFakePiRuntime({
      responses: {
        get_state: { data: { sessionId: 'pi-s1', sessionFile: FAKE_SESSION_FILE } },
      },
      responseSequences: {
        fork: [{ data: { cancelled: true } }, { success: false, error: 'Invalid entry ID for forking' }],
      },
    });
    try {
      await runtime.ensure();
      await expect(runtime.forkToEntry('u-entry-1')).rejects.toThrow(/rewind was cancelled/i);
      await expect(runtime.forkToEntry('missing-entry')).rejects.toThrow(/Invalid entry ID/);
      await expect(runtime.forkToEntry('   ')).rejects.toThrow(/target entry id/i);
    } finally {
      await runtime.shutdown();
    }
  });
});
