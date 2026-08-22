import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppServerTransport,
  type AppServerTransportOptions,
} from './appServerTransport.js';
import { CodexAppServerRuntime } from './codexAppServerRuntime.js';
import { proxyManager } from './proxyManager.js';
import type { SidecarCommand } from './types.js';

type EnsureCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;

type WireMessage = Record<string, unknown>;

type LogEntry = {
  direction: 'sent' | 'received' | 'response' | 'parse-error';
  message?: WireMessage;
  id?: string;
  method?: string | null;
};

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

const DEFAULT_TURN_NOTIFICATIONS = [
  { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
  {
    delayMs: 5,
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', delta: 'Hello' },
  },
  {
    delayMs: 10,
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread_1',
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    },
  },
  {
    delayMs: 15,
    method: 'item/completed',
    params: {
      threadId: 'thread_1',
      turnId: 'turn_1',
      item: { type: 'agentMessage', id: 'item_1', text: 'Hello world' },
    },
  },
  {
    delayMs: 20,
    method: 'turn/completed',
    params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
  },
];

const DEFAULT_SCENARIO = {
  responses: {
    'thread/start': { result: { thread: { id: 'thread_1' } } },
    'turn/start': {
      result: {},
      thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
    },
  },
};

type Harness = {
  runtime: CodexAppServerRuntime;
  events: Array<Record<string, unknown>>;
  readLog: () => LogEntry[];
  ensureCommand: (overrides?: Partial<EnsureCommand>) => EnsureCommand;
  cwd: string;
};

async function createHarness(scenario: Record<string, unknown>): Promise<Harness> {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-runtime-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-cwd-'));
  pendingCleanups.push(() => {
    for (const dir of [runtimeDir, cwd]) {
      try {
        fs.rmSync(dir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup for temp directories.
      }
    }
  });

  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'fake-runtime' }));
  const binDir = path.join(runtimeDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  // Cover both win32 (codex.cmd) and POSIX (codex) resolution paths.
  fs.writeFileSync(path.join(binDir, 'codex.cmd'), '');
  fs.writeFileSync(path.join(binDir, 'codex'), '');

  const logPath = path.join(
    os.tmpdir(),
    `fake-app-server-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(logPath, '');
  pendingCleanups.push(() => {
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // Best-effort cleanup for temp files.
    }
  });

  const events: Array<Record<string, unknown>> = [];
  const runtime = new CodexAppServerRuntime({
    connect: (options: AppServerTransportOptions) =>
      AppServerTransport.connect({
        ...options,
        executable: process.execPath,
        args: [FIXTURE_PATH],
        env: {
          ...options.env,
          FAKE_APP_SERVER_SCENARIO: JSON.stringify(scenario),
          FAKE_APP_SERVER_LOG: logPath,
        },
        requestTimeoutMs: 5_000,
        initializeTimeoutMs: 15_000,
      }),
    emit: (event) => {
      events.push(event as Record<string, unknown>);
    },
  });

  const ensureCommand = (overrides: Partial<EnsureCommand> = {}): EnsureCommand => ({
    type: 'ensure_session',
    cwd,
    sessionId: 'sess_1',
    runtimeRef: {
      provider: 'codex',
      runtimeRoot: path.dirname(runtimeDir),
      runtimePath: runtimeDir,
      runtimeVersion: 'test',
    },
    timeouts: { idle_timeout_ms: 10_000 },
    ...overrides,
  });

  const readLog = (): LogEntry[] =>
    fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LogEntry);

  return { runtime, events, readLog, ensureCommand, cwd };
}

function receivedRequests(log: LogEntry[], method: string): WireMessage[] {
  return log
    .filter((entry) => entry.direction === 'received' && entry.message?.method === method)
    .map((entry) => entry.message as WireMessage);
}

function eventTypes(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.type));
}

function waitForEvent(
  events: Array<Record<string, unknown>>,
  type: string,
): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const event = events.find((candidate) => candidate.type === type);
    expect(event).toBeDefined();
    return event as Record<string, unknown>;
  }, { timeout: 5_000, interval: 20 });
}

describe('CodexAppServerRuntime (fake app-server)', () => {
  it('rejects sendInput before ensure_session', async () => {
    const { runtime } = await createHarness(DEFAULT_SCENARIO);
    try {
      await expect(runtime.sendInput('hi')).rejects.toThrow(/not initialized/i);
    } finally {
      await runtime.shutdown();
    }
  });

  it(
    'ensure starts a new thread and emits the session mapping',
    async () => {
      const { runtime, events, readLog, ensureCommand, cwd } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand());

        const threadStarts = receivedRequests(readLog(), 'thread/start');
        expect(threadStarts).toHaveLength(1);
        expect(threadStarts[0]?.params).toMatchObject({ cwd });
        // Default permission snapshot (no permissionConfig): full access, no approvals.
        expect(threadStarts[0]?.params).toMatchObject({
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        });

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_session_mapping',
            app_session_id: 'sess_1',
            agent_kind: 'codex',
            agent_session_id: 'thread_1',
          }),
        );
        expect(eventTypes(events)).toContain('mcp_status_update');
        expect(eventTypes(events)).toContain('proxy_status');
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'a second ensure with the same config reuses the live thread',
    async () => {
      const { runtime, readLog, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand());
        await runtime.ensure(ensureCommand());

        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'ensure resumes an existing thread via thread/resume instead of thread/start',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/resume': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand({ agentSessionId: 'thread_existing' }));

        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(0);
        const resumes = receivedRequests(readLog(), 'thread/resume');
        expect(resumes).toHaveLength(1);
        expect(resumes[0]?.params).toMatchObject({ threadId: 'thread_existing' });

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_session_mapping',
            agent_session_id: 'thread_1',
          }),
        );
        // Resume succeeded — no rebuild event.
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: 'system_event', subtype: 'native_session_rebuilt' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'a failed thread/resume rebuilds the native session and emits native_session_rebuilt',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_new' } } },
          'thread/resume': { error: { code: -32000, message: 'thread not found' } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand({ agentSessionId: 'thread_gone' }));

        expect(receivedRequests(readLog(), 'thread/resume')).toHaveLength(1);
        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(1);

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'system_event',
            subtype: 'native_session_rebuilt',
            agent_kind: 'codex',
            previous_agent_session_id: 'thread_gone',
            agent_session_id: 'thread_new',
            reason: expect.stringContaining('thread not found'),
          }),
        );
        // The mapping must point at the rebuilt thread.
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_session_mapping',
            agent_session_id: 'thread_new',
          }),
        );

        // Turns continue on the rebuilt thread.
        events.length = 0;
        await runtime.sendInput('continue');
        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({ threadId: 'thread_new' });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'runs a full turn: streams deltas, emits the assistant message, and finishes with usage',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand({ reasoningEffort: 'high' }));
        events.length = 0;

        await runtime.sendInput('Say hello');

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts).toHaveLength(1);
        expect(turnStarts[0]?.params).toMatchObject({
          threadId: 'thread_1',
          input: [{ type: 'text', text: 'Say hello', text_elements: [] }],
          effort: 'high',
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        });

        expect(eventTypes(events)).toEqual([
          'system_event',
          'content_started',
          'text_delta',
          'content_finished',
          'assistant_message',
          'turn_finished',
          'sidecar_query_done',
        ]);

        expect(events[0]).toMatchObject({
          type: 'system_event',
          subtype: 'init',
          session_id: 'sess_1',
          cwd: ensureCommand().cwd,
          permissionMode: 'danger-full-access/never/network-on',
        });
        expect(events[1]).toMatchObject({ type: 'content_started', index: 0, content_kind: 'text' });
        expect(events[2]).toMatchObject({ type: 'text_delta', index: 0, text: 'Hello' });
        expect(events[4]).toMatchObject({
          type: 'assistant_message',
          session_id: 'sess_1',
          content: [{ type: 'text', text: 'Hello world' }],
          provider_message_id: 'item_1',
          provider_turn_id: 'turn_1',
        });
        expect(events[5]).toMatchObject({
          type: 'turn_finished',
          session_id: 'sess_1',
          outcome: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cached_input_tokens: 2,
            reasoning_output_tokens: 1,
          },
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'maps the codex permission snapshot onto turn/start approval/sandbox params',
    async () => {
      const { runtime, events, readLog, ensureCommand, cwd } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(
          ensureCommand({
            permissionConfig: {
              kind: 'codex',
              workflowMode: 'auto',
              networkAccessEnabled: false,
            },
          }),
        );

        const threadStarts = receivedRequests(readLog(), 'thread/start');
        expect(threadStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });

        events.length = 0;
        await runtime.sendInput('do work');

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        });
        expect(turnStarts[0]?.params).not.toHaveProperty('approvalsReviewer');
        expect(events[0]).toMatchObject({
          type: 'system_event',
          permissionMode: 'workspace-write/on-request/network-off',
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'maps the auto-review workflow tier onto turn/start with the auto_review approvals reviewer',
    async () => {
      const { runtime, events, readLog, ensureCommand, cwd } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(
          ensureCommand({
            permissionConfig: {
              kind: 'codex',
              workflowMode: 'auto-review',
              networkAccessEnabled: true,
            },
          }),
        );

        const threadStarts = receivedRequests(readLog(), 'thread/start');
        expect(threadStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          approvalsReviewer: 'auto_review',
        });

        events.length = 0;
        await runtime.sendInput('do risky work');

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [cwd],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        });
        expect(events[0]).toMatchObject({
          type: 'system_event',
          permissionMode: 'workspace-write/on-request/auto_review/network-on',
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'maps the read-only workflow tier onto turn/start with a read-only sandbox',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(
          ensureCommand({
            permissionConfig: {
              kind: 'codex',
              workflowMode: 'read-only',
              networkAccessEnabled: false,
            },
          }),
        );

        const threadStarts = receivedRequests(readLog(), 'thread/start');
        expect(threadStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
        });

        events.length = 0;
        await runtime.sendInput('explore the repo');

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        });
        expect(events[0]).toMatchObject({
          type: 'system_event',
          permissionMode: 'read-only/on-request/network-off',
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'plan mode keeps the workflow tier and pins the plan collaborationMode on turn/start',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness({
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      });
      try {
        await runtime.ensure(
          ensureCommand({
            permissionConfig: {
              kind: 'codex',
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
            },
            planMode: 'on',
          }),
        );

        // Orthogonal (ADR 0010 Decision 4): plan does NOT downgrade the tier.
        const threadStarts = receivedRequests(readLog(), 'thread/start');
        expect(threadStarts[0]?.params).toMatchObject({
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        });

        const input = runtime.sendInput('plan something');
        const approval = await waitForEvent(events, 'permission_requested');
        await runtime.respondToPermission(String(approval.request_id), 'reject');
        await input;

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
          collaborationMode: { mode: 'plan', settings: { model: 'o4-mini' } },
        });
        // The plan preset governs effort; no top-level override is sent.
        expect(turnStarts[0]?.params).not.toHaveProperty('effort');
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'restores the default collaborationMode on plan-off turns after resolving presets',
    async () => {
      const { runtime, readLog, ensureCommand } = await createHarness({
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'collaborationMode/list': {
            result: {
              data: [
                { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
                { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
              ],
            },
          },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      });
      try {
        await runtime.ensure(ensureCommand({ reasoningEffort: 'high' }));
        await runtime.sendInput('normal coding');

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts[0]?.params).toMatchObject({
          collaborationMode: { mode: 'default', settings: { model: 'o4-mini' } },
          effort: 'high',
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'surfaces a failed turn as an error event and a failed turn_finished',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: [
              {
                delayMs: 0,
                method: 'turn/completed',
                params: {
                  threadId: 'thread_1',
                  turn: { id: 'turn_1', status: 'failed', error: { message: 'model overloaded' } },
                },
              },
            ],
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('boom');

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            subtype: 'runtime',
            error: expect.stringContaining('model overloaded'),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn_finished',
            outcome: 'failed',
            reason: expect.stringContaining('model overloaded'),
          }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'settles an in-flight turn as failed when the app-server process crashes',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: [
              { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
            ],
            thenExit: { code: 1, delayMs: 10 },
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('hang');

        const errors = events.filter((event) => event.type === 'error');
        expect(errors).toHaveLength(1);
        expect(String(errors[0]?.error)).toMatch(/连接中断|进程退出/);

        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ outcome: 'failed' });
        expect(eventTypes(events)).toContain('sidecar_query_done');
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'interrupt sends turn/interrupt and settles the turn as interrupted',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: [
              { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_9' } } },
            ],
          },
        },
      };
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('long running');
        await vi.waitFor(() => {
          expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(1);
        });
        await runtime.interrupt();
        await input;

        const interrupts = receivedRequests(readLog(), 'turn/interrupt');
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0]?.params).toMatchObject({ threadId: 'thread_1', turnId: 'turn_9' });

        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'interrupted' }),
        );
        expect(eventTypes(events)).toContain('sidecar_query_done');
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'resetSession tears down the transport so the next ensure spawns a fresh thread',
    async () => {
      const { runtime, readLog, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand());
        await runtime.resetSession('sess_1');
        await runtime.ensure(ensureCommand());

        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(2);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'deleteSession sends thread/delete and disposes the transport',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/delete': { result: {} },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        await runtime.deleteSession('thread_1');

        const deletes = receivedRequests(readLog(), 'thread/delete');
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.params).toMatchObject({ threadId: 'thread_1' });

        // The next ensure must spawn a fresh app-server and thread.
        await runtime.ensure(ensureCommand());
        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(2);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );
});

describe('CodexAppServerRuntime interactive request approvals', () => {
  function approvalScenario(
    serverRequest: Record<string, unknown>,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      responses: {
        'thread/start': { result: { thread: { id: 'thread_1' } } },
        'turn/start': {
          result: {},
          thenNotifications: [
            { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
            { delayMs: 5, serverRequest },
          ],
        },
        ...extras,
      },
    };
  }

  function serverResponses(log: LogEntry[], method: string): WireMessage[] {
    return log
      .filter((entry) => entry.direction === 'response' && entry.method === method)
      .map((entry) => entry.message as WireMessage);
  }

  it(
    'emits permission_requested for command approvals and forwards the accept decision',
    async () => {
      const scenario = approvalScenario({
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'item_cmd',
          command: 'npm test',
          cwd: 'D:\\repo',
          reason: 'Run the test suite',
        },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('run tests');
        const permission = await waitForEvent(events, 'permission_requested');
        expect(permission).toMatchObject({
          session_id: 'sess_1',
          permission_type: 'execute',
          description: 'Run the test suite',
          metadata: { title: '运行命令', command: 'npm test', cwd: 'D:\\repo' },
        });
        expect(typeof permission.request_id).toBe('string');
        expect(runtime.isPendingQuestion(String(permission.request_id))).toBe(false);

        await runtime.respondToPermission(String(permission.request_id), 'once');
        await input;

        const responses = serverResponses(readLog(), 'item/commandExecution/requestApproval');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { decision: 'accept' } });
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'forwards reject and always decisions as decline and acceptForSession',
    async () => {
      const scenario = approvalScenario({
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1', command: 'rm -rf /' },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('danger');
        const permission = await waitForEvent(events, 'permission_requested');
        await runtime.respondToPermission(String(permission.request_id), 'reject');
        await input;

        const responses = serverResponses(readLog(), 'item/commandExecution/requestApproval');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { decision: 'decline' } });

        // Second turn: "always" maps to acceptForSession.
        events.length = 0;
        const secondInput = runtime.sendInput('danger again');
        const secondPermission = await waitForEvent(events, 'permission_requested');
        await runtime.respondToPermission(String(secondPermission.request_id), 'always');
        await secondInput;

        const allResponses = serverResponses(readLog(), 'item/commandExecution/requestApproval');
        expect(allResponses).toHaveLength(2);
        expect(allResponses[1]).toMatchObject({ result: { decision: 'acceptForSession' } });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'answers v1 execCommandApproval aliases with the review decision payload',
    async () => {
      const scenario = approvalScenario({
        method: 'execCommandApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1', command: ['git', 'status'], cwd: 'D:\\repo' },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('status');
        const permission = await waitForEvent(events, 'permission_requested');
        expect(permission).toMatchObject({
          permission_type: 'execute',
          metadata: { command: 'git status' },
        });

        await runtime.respondToPermission(String(permission.request_id), 'once');
        await input;

        const responses = serverResponses(readLog(), 'execCommandApproval');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { decision: 'approved' } });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'emits a write permission for file change approvals',
    async () => {
      const scenario = approvalScenario({
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_patch', grantRoot: 'D:\\repo\\src' },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('patch files');
        const permission = await waitForEvent(events, 'permission_requested');
        expect(permission).toMatchObject({
          permission_type: 'write',
          description: 'Codex 请求修改文件',
          metadata: { title: '修改文件', path: 'D:\\repo\\src' },
        });

        await runtime.respondToPermission(String(permission.request_id), 'once');
        await input;

        const responses = serverResponses(readLog(), 'item/fileChange/requestApproval');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { decision: 'accept' } });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'interrupt cancels outstanding approvals and settles the turn as interrupted',
    async () => {
      const scenario = approvalScenario({
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1', command: 'long-running' },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('long running');
        await waitForEvent(events, 'permission_requested');

        await runtime.interrupt();
        await input;

        const responses = serverResponses(readLog(), 'item/commandExecution/requestApproval');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { decision: 'cancel' } });
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'interrupted' }),
        );
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'bridges tool user-input questions and returns structured answers',
    async () => {
      const scenario = approvalScenario({
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          questions: [
            {
              id: 'q1',
              question: '继续吗？',
              header: 'Confirm',
              options: [{ label: '是' }, { label: '否' }],
            },
          ],
        },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('ask me');
        const question = await waitForEvent(events, 'user_input_requested');
        expect(question).toMatchObject({
          session_id: 'sess_1',
          questions: [
            {
              question: '继续吗？',
              header: 'Confirm',
              options: [{ label: '是' }, { label: '否' }],
            },
          ],
        });
        const requestId = String(question.tool_use_id);
        expect(runtime.isPendingQuestion(requestId)).toBe(true);

        await runtime.respondToQuestion(requestId, [['是']]);
        await input;

        const responses = serverResponses(readLog(), 'item/tool/requestUserInput');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
          result: { answers: { q1: { answers: ['是'] } } },
        });
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'answers form-mode MCP elicitations with accept and mapped content',
    async () => {
      const scenario = approvalScenario({
        method: 'mcpServer/elicitation/request',
        params: {
          mode: 'form',
          message: '选择部署环境',
          requestedSchema: {
            type: 'object',
            properties: {
              env: { type: 'string', title: '环境', enum: ['dev', 'prod'] },
            },
            required: ['env'],
          },
        },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('deploy');
        const question = await waitForEvent(events, 'user_input_requested');
        expect(question.questions).toEqual([
          expect.objectContaining({
            question: expect.stringContaining('选择部署环境'),
            options: [
              expect.objectContaining({ label: 'dev', value: 'dev' }),
              expect.objectContaining({ label: 'prod', value: 'prod' }),
            ],
          }),
        ]);

        await runtime.respondToQuestion(String(question.tool_use_id), [['dev']]);
        await input;

        const responses = serverResponses(readLog(), 'mcpServer/elicitation/request');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
          result: { action: 'accept', content: { env: 'dev' } },
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'strategically declines url-mode elicitations without blocking the turn',
    async () => {
      const scenario = approvalScenario({
        method: 'mcpServer/elicitation/request',
        params: { mode: 'url', message: 'Open the docs', url: 'https://example.com/docs' },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('open docs');

        const responses = serverResponses(readLog(), 'mcpServer/elicitation/request');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ result: { action: 'decline' } });
        expect(events.some((event) => event.type === 'user_input_requested')).toBe(false);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'suspends the idle guard while an approval is pending (ADR 0004)',
    async () => {
      const scenario = approvalScenario({
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1', command: 'slow approval' },
        thenNotify: {
          method: 'turn/completed',
          params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } },
        },
      });
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand({ timeouts: { idle_timeout_ms: 300 } }));
        events.length = 0;

        const input = runtime.sendInput('slow turn');
        const permission = await waitForEvent(events, 'permission_requested');

        // Wait well past the idle timeout — the guard must stay suspended
        // while the user has not answered yet.
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(events.some((event) => event.type === 'turn_finished')).toBe(false);

        await runtime.respondToPermission(String(permission.request_id), 'once');
        await input;

        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'rejects permission responses when no app-server session is established',
    async () => {
      const { runtime } = await createHarness(DEFAULT_SCENARIO);
      try {
        await expect(runtime.respondToPermission('perm-1', 'once')).rejects.toThrow(/not initialized/i);
        await expect(runtime.respondToQuestion('q-1', [['是']])).rejects.toThrow(/not initialized/i);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  // ─── Issue 08: manual context compaction (/compact) ────────────────────

  const compactBoundaryEvents = (events: Array<Record<string, unknown>>) =>
    events.filter(
      (event) => event.type === 'system_event' && event.subtype === 'compact_boundary',
    );

  const COMPACT_TURN_NOTIFICATIONS = [
    { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_c' } } },
    {
      delayMs: 5,
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_c',
        item: { type: 'contextCompaction', id: 'item_c' },
      },
    },
    {
      delayMs: 10,
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_c',
        item: { type: 'contextCompaction', id: 'item_c' },
      },
    },
    {
      delayMs: 15,
      method: 'turn/completed',
      params: { threadId: 'thread_1', turn: { id: 'turn_c', status: 'completed' } },
    },
  ];

  const compactScenario = {
    responses: {
      'thread/start': { result: { thread: { id: 'thread_1' } } },
      'turn/start': {
        result: {},
        thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
      },
      'thread/compact/start': {
        result: {},
        thenNotifications: COMPACT_TURN_NOTIFICATIONS,
      },
    },
  };

  it(
    'routes /compact to thread/compact/start and emits the manual boundary lifecycle',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(compactScenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('/compact');

        // The RPC went to thread/compact/start, not turn/start.
        expect(receivedRequests(readLog(), 'thread/compact/start')).toHaveLength(1);
        expect(receivedRequests(readLog(), 'thread/compact/start')[0]?.params).toMatchObject({
          threadId: 'thread_1',
        });
        expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(0);

        // Loading → completed boundary, both marked manual.
        const boundaries = compactBoundaryEvents(events);
        expect(boundaries).toHaveLength(2);
        expect(boundaries[0]).toMatchObject({
          compact_metadata: { trigger: 'manual', status: 'compacting' },
        });
        expect(boundaries[1]).toMatchObject({
          compact_metadata: { trigger: 'manual', status: 'completed' },
        });
        // The compaction summary must not surface as an assistant message.
        expect(events.some((event) => event.type === 'assistant_message')).toBe(false);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'deduplicates the deprecated thread/compacted notification against the item lifecycle',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/compact/start': {
            result: {},
            thenNotifications: [
              ...COMPACT_TURN_NOTIFICATIONS,
              {
                delayMs: 12,
                method: 'thread/compacted',
                params: { threadId: 'thread_1', turnId: 'turn_c' },
              },
            ],
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('/compact');

        const boundaries = compactBoundaryEvents(events);
        expect(boundaries).toHaveLength(2);
        expect(boundaries.filter((boundary) => boundary.compact_metadata?.status === 'completed'))
          .toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'flushes an unpaired compaction item at turn end (builds without item/completed)',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/compact/start': {
            result: {},
            thenNotifications: [
              { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_c' } } },
              {
                delayMs: 5,
                method: 'item/started',
                params: {
                  threadId: 'thread_1',
                  turnId: 'turn_c',
                  item: { type: 'contextCompaction', id: 'item_c' },
                },
              },
              {
                delayMs: 15,
                method: 'turn/completed',
                params: { threadId: 'thread_1', turn: { id: 'turn_c', status: 'completed' } },
              },
            ],
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('/compact');

        const boundaries = compactBoundaryEvents(events);
        expect(boundaries).toHaveLength(2);
        expect(boundaries[1]).toMatchObject({
          compact_metadata: { trigger: 'manual', status: 'completed' },
        });
        // The flushed boundary lands before the turn settles.
        const turnFinishedIdx = events.findIndex((event) => event.type === 'turn_finished');
        const completedBoundaryIdx = boundaries
          .findIndex((boundary) => boundary.compact_metadata?.status === 'completed');
        expect(turnFinishedIdx).toBeGreaterThan(completedBoundaryIdx);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'marks auto compaction items during a regular turn with trigger auto',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: [
              ...DEFAULT_TURN_NOTIFICATIONS.slice(0, 2),
              {
                delayMs: 12,
                method: 'item/started',
                params: {
                  threadId: 'thread_1',
                  turnId: 'turn_1',
                  item: { type: 'contextCompaction', id: 'item_auto' },
                },
              },
              {
                delayMs: 14,
                method: 'item/completed',
                params: {
                  threadId: 'thread_1',
                  turnId: 'turn_1',
                  item: { type: 'contextCompaction', id: 'item_auto' },
                },
              },
              ...DEFAULT_TURN_NOTIFICATIONS.slice(2),
            ],
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('hello');

        const boundaries = compactBoundaryEvents(events);
        expect(boundaries).toHaveLength(2);
        expect(boundaries[0]).toMatchObject({
          compact_metadata: { trigger: 'auto', status: 'compacting' },
        });
        expect(boundaries[1]).toMatchObject({
          compact_metadata: { trigger: 'auto', status: 'completed' },
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'forwards /compact text with images to the normal turn instead of the compact RPC',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(compactScenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        await runtime.sendInput('/compact', {
          text: '/compact',
          images: [{ name: 'chart.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGk=', size: 3 }],
        });

        expect(receivedRequests(readLog(), 'thread/compact/start')).toHaveLength(0);
        expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  // ─── Issue 07: Plan Mode + Plan Approval closure ────────────────────────

  const planTurnNotifications = (planText: string) => [
    { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_p' } } },
    {
      delayMs: 5,
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_p',
        item: { type: 'agentMessage', id: 'item_plan', text: planText },
      },
    },
    {
      delayMs: 10,
      method: 'turn/completed',
      params: { threadId: 'thread_1', turn: { id: 'turn_p', status: 'completed' } },
    },
  ];

  function planScenario(): Record<string, unknown> {
    return {
      responses: {
        'thread/start': { result: { thread: { id: 'thread_1' } } },
        'thread/delete': { result: {} },
      },
      responseSequences: {
        'turn/start': [
          {
            result: {},
            thenNotifications: planTurnNotifications('## 计划\n\n1. 先写测试\n2. 再实现'),
          },
          {
            result: {},
            thenNotifications: [
              { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_impl' } } },
              {
                delayMs: 5,
                method: 'item/completed',
                params: {
                  threadId: 'thread_1',
                  turnId: 'turn_impl',
                  item: { type: 'agentMessage', id: 'item_impl', text: 'Done implementing.' },
                },
              },
              {
                delayMs: 10,
                method: 'turn/completed',
                params: { threadId: 'thread_1', turn: { id: 'turn_impl', status: 'completed' } },
              },
            ],
          },
        ],
      },
    };
  }

  it(
    'synthesizes a Plan Approval after a plan turn and runs the implementation turn on Implement',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(planScenario());
      try {
        await runtime.ensure(ensureCommand({ planMode: 'on' }));
        events.length = 0;

        const input = runtime.sendInput('帮我规划重构');
        const approval = await waitForEvent(events, 'permission_requested');
        // The turn is held open while the approval pends.
        expect(events.some((event) => event.type === 'turn_finished')).toBe(false);
        expect(approval).toMatchObject({
          session_id: 'sess_1',
          permission_type: 'plan_approval',
          metadata: {
            presentation: 'plan-approval',
            title: '实施计划',
            plan: expect.stringContaining('先写测试'),
          },
        });
        expect(runtime.isPendingQuestion(String(approval.request_id))).toBe(false);

        await runtime.respondToPermission(String(approval.request_id), 'once');
        await input;

        // Plan Mode closed automatically and surfaced to the frontend.
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'permission_mode_changed', plan_mode: 'off' }),
        );

        const turnStarts = receivedRequests(readLog(), 'turn/start');
        expect(turnStarts).toHaveLength(2);
        // First turn: plan collaborationMode; follow-up: default.
        expect(turnStarts[0]?.params).toMatchObject({
          collaborationMode: { mode: 'plan', settings: { model: 'o4-mini' } },
        });
        expect(turnStarts[1]?.params).toMatchObject({
          collaborationMode: { mode: 'default' },
          input: [{ type: 'text', text: expect.stringContaining('实施') }],
        });

        // Two completed turns, both reported.
        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(finished).toHaveLength(2);
        expect(finished[0]).toMatchObject({ outcome: 'completed' });
        expect(finished[1]).toMatchObject({ outcome: 'completed' });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'dismisses the Plan Approval without starting an implementation turn',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(planScenario());
      try {
        await runtime.ensure(ensureCommand({ planMode: 'on' }));
        events.length = 0;

        const input = runtime.sendInput('帮我规划重构');
        const approval = await waitForEvent(events, 'permission_requested');
        await runtime.respondToPermission(String(approval.request_id), 'reject');
        await input;

        expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(1);
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: 'permission_mode_changed' }),
        );
        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ outcome: 'completed' });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'dismisses a pending Plan Approval when the turn is interrupted',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(planScenario());
      try {
        await runtime.ensure(ensureCommand({ planMode: 'on' }));
        events.length = 0;

        const input = runtime.sendInput('帮我规划重构');
        await waitForEvent(events, 'permission_requested');
        await runtime.interrupt();
        await input;

        expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(1);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'turn_finished', outcome: 'completed' }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'suspends the idle guard while a Plan Approval is pending (ADR 0004)',
    async () => {
      const { runtime, events, readLog, ensureCommand } = await createHarness(planScenario());
      try {
        await runtime.ensure(ensureCommand({ planMode: 'on', timeouts: { idle_timeout_ms: 300 } }));
        events.length = 0;

        const input = runtime.sendInput('帮我规划重构');
        const approval = await waitForEvent(events, 'permission_requested');

        // Wait well past the idle timeout — the held turn must not be killed
        // while the user has not decided yet.
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(events.some((event) => event.type === 'turn_finished')).toBe(false);

        // Approving re-arms the window and starts the implementation turn.
        await runtime.respondToPermission(String(approval.request_id), 'once');
        await input;

        expect(receivedRequests(readLog(), 'turn/start')).toHaveLength(2);
        const finished = events.filter((event) => event.type === 'turn_finished');
        expect(finished).toHaveLength(2);
        expect(finished.every((event) => event.outcome === 'completed')).toBe(true);
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'aborts a pending Plan Approval as a failed turn when the app-server crashes',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: planTurnNotifications('## 计划'),
            thenExit: { code: 1, delayMs: 12 },
          },
        },
      };
      const { runtime, events, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand({ planMode: 'on' }));
        events.length = 0;

        // approval_timeout 0 (infinite) — only the crash may settle the turn.
        const input = runtime.sendInput('帮我规划重构');
        await waitForEvent(events, 'permission_requested');
        await input;

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn_finished',
            outcome: 'failed',
            reason: expect.stringContaining('连接中断'),
          }),
        );
        expect(eventTypes(events)).toContain('sidecar_query_done');
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  // ─── Issue 06: mid-turn permission update deferral ──────────────────────

  it(
    'emits permission_update_deferred when permissions change mid-turn',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'turn/start': {
            result: {},
            thenNotifications: [
              { delayMs: 0, method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
              { delayMs: 400, method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } },
            ],
          },
        },
      };
      const { runtime, events, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        events.length = 0;

        const input = runtime.sendInput('long running');
        await vi.waitFor(() => {
          expect(events.some((event) => event.type === 'system_event')).toBe(true);
        });
        runtime.updatePermissions({
          type: 'update_permissions',
          sessionId: 'sess_1',
          agentKind: 'codex',
          permissionConfig: { kind: 'codex', workflowMode: 'read-only' },
        });
        await input;

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'system_event',
            subtype: 'permission_update_deferred',
            session_id: 'sess_1',
          }),
        );

        // A follow-up ensure with the same snapshot must not respawn the
        // app-server (fingerprint stays in sync with updatePermissions).
        await runtime.ensure(ensureCommand({
          permissionConfig: { kind: 'codex', workflowMode: 'read-only' },
        }));
        expect(receivedRequests(readLog(), 'thread/start')).toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  // ─── Issue 09: third-party upstream compat-proxy rehoming ───────────────

  it(
    'routes codex_needs_proxy providers through the local compat proxy',
    async () => {
      const { runtime, events, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand({
          apiKey: 'sk-third-party',
          baseUrl: 'https://gateway.example.com/v1',
          codexNeedsProxy: true,
        }));

        const proxyStatus = events.find((event) => event.type === 'proxy_status') as
          | Record<string, unknown>
          | undefined;
        expect(proxyStatus).toMatchObject({ running: true });
        expect(String(proxyStatus?.upstreamBaseUrl)).toContain('gateway.example.com');
      } finally {
        await runtime.shutdown();
        await proxyManager.stop();
      }
    },
    20_000,
  );

  it(
    'dials official OpenAI directly without starting the compat proxy',
    async () => {
      const { runtime, events, ensureCommand } = await createHarness(DEFAULT_SCENARIO);
      try {
        await runtime.ensure(ensureCommand({
          apiKey: 'sk-official',
          baseUrl: 'https://api.openai.com/v1',
          codexNeedsProxy: false,
        }));

        const proxyStatus = events.find((event) => event.type === 'proxy_status') as
          | Record<string, unknown>
          | undefined;
        expect(proxyStatus).toMatchObject({ running: false });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  // ─── Issue 10: fork on the persistent app-server connection ─────────────

  it(
    'forks via thread/fork on the long-lived transport and returns the child thread id',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/fork': { result: { thread: { id: 'thread_child' } } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());

        const childThreadId = await runtime.forkSession('thread_1');
        expect(childThreadId).toBe('thread_child');

        const forks = receivedRequests(readLog(), 'thread/fork');
        expect(forks).toHaveLength(1);
        expect(forks[0]?.params).toMatchObject({ threadId: 'thread_1' });

        // The parent runtime keeps its own thread mapping.
        await runtime.sendInput('still parent thread');
        expect(receivedRequests(readLog(), 'turn/start')[0]?.params).toMatchObject({
          threadId: 'thread_1',
        });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'resolves the fork point by turn ordinal through thread/turns/list',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/turns/list': {
            result: { data: [{ id: 'turn_a' }, { id: 'turn_b' }, { id: 'turn_c' }] },
          },
          'thread/fork': { result: { thread: { id: 'thread_child' } } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, readLog, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());

        const childThreadId = await runtime.forkSession('thread_1', undefined, 1);
        expect(childThreadId).toBe('thread_child');

        const forks = receivedRequests(readLog(), 'thread/fork');
        expect(forks[0]?.params).toMatchObject({ threadId: 'thread_1', lastTurnId: 'turn_b' });
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );

  it(
    'surfaces fork failures as a readable error',
    async () => {
      const scenario = {
        responses: {
          'thread/start': { result: { thread: { id: 'thread_1' } } },
          'thread/fork': { error: { code: -32000, message: 'source thread missing' } },
          'turn/start': {
            result: {},
            thenNotifications: DEFAULT_TURN_NOTIFICATIONS,
          },
        },
      };
      const { runtime, ensureCommand } = await createHarness(scenario);
      try {
        await runtime.ensure(ensureCommand());
        await expect(runtime.forkSession('thread_1')).rejects.toThrow(/source thread missing/);
      } finally {
        await runtime.shutdown();
      }
    },
    20_000,
  );
});
