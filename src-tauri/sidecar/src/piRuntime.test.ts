import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PiRpcProcess } from './piRpcTransport.js';
import { PiRuntime } from './piRuntime.js';
import type { PiSessionConfig } from './types.js';

const FAKE_PI_PATH = fileURLToPath(new URL('./__fixtures__/fake-pi.mjs', import.meta.url));
const FAKE_SESSION_FILE = path.join(os.tmpdir(), `pi-fake-session-${process.pid}.jsonl`);

type WireMessage = Record<string, unknown>;

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
});
