import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { PiRpcProcess } from './piRpcTransport.js';
import { PiRuntime } from './piRuntime.js';
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
});
