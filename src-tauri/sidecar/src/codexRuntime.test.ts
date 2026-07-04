import { describe, expect, it, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';

import {
  applyCodexWindowsSandboxPathCompatibility,
  buildCodexCliConfig,
  CodexSessionRuntime,
  shouldRouteCodexThroughCompatProxy,
} from './codexRuntime.js';
import {
  clearActivePermissionState,
  setActivePermissionState,
} from './activePermissionState.js';
import { resolveCodexCollaborationPolicy } from './codexCollaborationPolicy.js';
import { buildCodexToolUseContent } from './runtimeEvents.js';
import { flushStreamEvents } from './streamEventBatcher.js';

describe('CodexSessionRuntime', () => {
  it('configures a native Responses model provider for the selected Codex provider', () => {
    expect(buildCodexCliConfig('https://example.test')).toEqual({
      model_provider: 'codemux_proxy',
      model_providers: {
        codemux_proxy: {
          name: 'CodeMUX Proxy',
          base_url: 'https://example.test/v1',
          env_key: 'OPENAI_API_KEY',
          wire_api: 'responses',
          requires_openai_auth: true,
        },
      },
      openai_base_url: 'https://example.test',
    });
    expect(buildCodexCliConfig('https://example.test/v1')).toMatchObject({
      model_providers: {
        codemux_proxy: {
          base_url: 'https://example.test/v1',
        },
      },
    });
  });

  it('renders Codex command executions as shell_command tool calls with user-facing commands', () => {
    expect(buildCodexToolUseContent({
      id: 'cmd-1',
      type: 'command_execution',
      command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem"',
      aggregated_output: '',
      status: 'in_progress',
    })).toEqual({
      type: 'tool_use',
      id: 'cmd-1',
      name: 'shell_command',
      input: { command: 'Get-ChildItem' },
    });
  });

  it('includes runtime shell command metadata for live Codex command executions', () => {
    expect(buildCodexToolUseContent({
      id: 'cmd-1',
      type: 'command_execution',
      command: 'node --check script.js',
      aggregated_output: '',
      status: 'in_progress',
    }, {
      workdir: 'D:\\project\\ai-code\\code-demo',
      timeoutMs: 10000,
    })).toEqual({
      type: 'tool_use',
      id: 'cmd-1',
      name: 'shell_command',
      input: {
        command: 'node --check script.js',
        timeout_ms: 10000,
        workdir: 'D:\\project\\ai-code\\code-demo',
      },
    });
  });

  it('renders Codex file changes as apply_patch tool calls', () => {
    expect(buildCodexToolUseContent({
      id: 'patch-1',
      type: 'file_change',
      changes: [
        { path: 'src/app.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
      status: 'completed',
    })).toEqual({
      type: 'tool_use',
      id: 'patch-1',
      name: 'apply_patch',
      input: {
        changes: [
          { path: 'src/app.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
      },
    });
  });

  it('drains the Codex SDK stream after turn.completed instead of closing it early', async () => {
    const writes: string[] = [];
    let returnedEarly = false;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
        };
        thread: {
          id: string;
          runStreamed: () => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
      };
      let nextCount = 0;
      const events = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          nextCount += 1;
          if (nextCount === 1) {
            return {
              done: false,
              value: {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent,
            };
          }
          return { done: true, value: undefined };
        },
        async return() {
          returnedEarly = true;
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          throw error;
        },
      } as AsyncGenerator<ThreadEvent>;

      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: () => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async () => ({
          events,
        }),
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('hello', undefined, false);

      expect(returnedEarly).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('treats a missing response.completed stream close as success after an assistant message completed', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
        };
        thread: {
          id: string;
          runStreamed: () => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: () => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: {
                id: 'agent-message-1',
                type: 'agent_message',
                text: 'Complete answer',
              },
            } as ThreadEvent;
            throw new Error('stream disconnected before completion: stream closed before response.completed');
          })(),
        }),
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('hello', undefined, false);

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents.some((event) => event.type === 'sidecar_error')).toBe(false);
      expect(emittedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'assistant' }),
          expect.objectContaining({ type: 'result', subtype: 'success', is_error: false }),
          expect.objectContaining({ type: 'sidecar_query_done' }),
        ]),
      );
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('includes reasoning effort in Codex thread options', () => {
    const runtime = new CodexSessionRuntime();
    (runtime as unknown as {
      config: {
        sessionId: string;
        cwd: string;
        model: string;
        reasoningEffort: string;
      };
    }).config = {
      sessionId: 'session-1',
      cwd: 'D:/repo',
      model: 'gpt-5',
      reasoningEffort: 'high',
    };

    const options = (runtime as unknown as { threadOptions: () => Record<string, unknown> }).threadOptions();

    expect(options).toMatchObject({
      model: 'gpt-5',
      modelReasoningEffort: 'high',
    });
  });

  it('uses read-only Codex thread options when plan mode is active', () => {
    const runtime = new CodexSessionRuntime();
    (runtime as unknown as {
      config: {
        sessionId: string;
        cwd: string;
        model: string;
        planMode: 'on';
        permissionConfig: {
          kind: 'codex';
          sandboxMode: 'danger-full-access';
          approvalPolicy: 'never';
          networkAccessEnabled: true;
        };
      };
    }).config = {
      sessionId: 'session-1',
      cwd: 'D:/repo',
      model: 'gpt-5',
      planMode: 'on',
      permissionConfig: {
        kind: 'codex',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      },
    };

    const options = (runtime as unknown as { threadOptions: () => Record<string, unknown> }).threadOptions();

    expect(options).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('routes Codex plan mode through the compat proxy even for OpenAI-native providers', () => {
    expect(shouldRouteCodexThroughCompatProxy(
      'https://api.openai.com/v1',
      false,
      resolveCodexCollaborationPolicy({ planMode: 'on' }),
    )).toBe(true);

    expect(shouldRouteCodexThroughCompatProxy(
      'https://api.openai.com/v1',
      false,
      resolveCodexCollaborationPolicy({ planMode: 'off' }),
    )).toBe(false);
  });

  it('removes WindowsApps from Codex PATH to keep read-only sandbox shell launch compatible', () => {
    const env = {
      Path: [
        'C:\\Windows\\System32',
        'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps',
        'C:\\Tools\\bin',
      ].join(';'),
    };

    applyCodexWindowsSandboxPathCompatibility(env);

    expect(env.Path).toBe('C:\\Windows\\System32;C:\\Tools\\bin');
  });

  it('injects strict-local plan directives before streaming Codex input', async () => {
    const writes: string[] = [];
    let streamedInput: unknown;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
        };
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async (input) => {
          streamedInput = input;
          return {
            events: (async function* () {
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent;
            })(),
          };
        },
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('build a login form', undefined, false);

      expect(streamedInput).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('Execution policy (plan mode): work in planning-only style.'),
        },
      ]);
      expect(JSON.stringify(streamedInput)).toContain('build a login form');
      expect(JSON.stringify(streamedInput)).not.toContain('$plan build a login form');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('injects code-mode checkpoint directives when plan mode is off', async () => {
    const writes: string[] = [];
    let streamedInput: unknown;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'off';
        };
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'off',
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async (input) => {
          streamedInput = input;
          return {
            events: (async function* () {
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent;
            })(),
          };
        },
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('fix the bug', undefined, false);

      expect(streamedInput).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('Execution policy (checkpoint mode): keep execution autonomous for routine work'),
        },
      ]);
      expect(JSON.stringify(streamedInput)).toContain('interaction_mode: checkpoint');
      expect(JSON.stringify(streamedInput)).toContain('request_user_input_policy: allow');
      expect(JSON.stringify(streamedInput)).toContain('fix the bug');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('injects full-access checkpoint directives that allow request_user_input', async () => {
    const writes: string[] = [];
    let streamedInput: unknown;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'off';
          permissionConfig: {
            kind: 'codex';
            sandboxMode: 'danger-full-access';
            approvalPolicy: 'never';
            networkAccessEnabled: true;
          };
        };
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'off',
        permissionConfig: {
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        },
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async (input) => {
          streamedInput = input;
          return {
            events: (async function* () {
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent;
            })(),
          };
        },
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('ask when blocked', undefined, false);

      expect(JSON.stringify(streamedInput)).toContain('interaction_mode: checkpoint');
      expect(JSON.stringify(streamedInput)).toContain('request_user_input_policy: allow');
      expect(JSON.stringify(streamedInput)).toContain('Execution policy (checkpoint mode): keep execution autonomous for routine work');
      expect(JSON.stringify(streamedInput)).toContain('you MAY use requestUserInput');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('emits incremental stream events from item.updated agent messages', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.updated',
        {
          id: 'agent-message-1',
          type: 'agent_message',
          text: '让我再次',
        },
        () => {},
      );
      emitItemEvent(
        'session-1',
        'item.updated',
        {
          id: 'agent-message-1',
          type: 'agent_message',
          text: '让我再次尝试调用 Context7 工具：',
        },
        () => {},
      );
      flushStreamEvents();

      const streamEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
        .flatMap((event) => event.type === 'stream_event_batch'
          ? event.events.map((streamEvent: unknown) => ({ type: 'stream_event', session_id: event.session_id, event: streamEvent }))
          : [event])
        .filter((event) => event.type === 'stream_event');

      expect(streamEvents).toEqual([
        {
          type: 'stream_event',
          session_id: 'session-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'text',
              text: '',
            },
          },
        },
        {
          type: 'stream_event',
          session_id: 'session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: '让我再次',
            },
          },
        },
        {
          type: 'stream_event',
          session_id: 'session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: '尝试调用 Context7 工具：',
            },
          },
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('emits failed mcp tool calls as error tool results', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'tool-1',
          type: 'mcp_tool_call',
          server: 'context7',
          tool: 'resolve-library-id',
          arguments: { libraryName: 'Context7' },
          error: {
            message: 'unsupported call: mcp__context7__resolve_library_id',
          },
          status: 'failed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'user',
          session_id: 'session-1',
          uuid: expect.any(String),
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'unsupported call: mcp__context7__resolve_library_id',
                is_error: true,
              },
            ],
          },
          parent_tool_use_id: null,
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('emits completed-only Codex file changes as a tool call and result', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'patch-1',
          type: 'file_change',
          changes: [
            { path: 'src/app.ts', kind: 'update' },
          ],
          status: 'completed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'assistant',
          session_id: 'session-1',
          uuid: expect.any(String),
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'patch-1',
                name: 'apply_patch',
                input: {
                  changes: [
                    { path: 'src/app.ts', kind: 'update' },
                  ],
                },
              },
            ],
          },
          parent_tool_use_id: null,
        },
        {
          type: 'user',
          session_id: 'session-1',
          uuid: expect.any(String),
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'patch-1',
                content: 'Patch completed: update src/app.ts',
                is_error: false,
              },
            ],
          },
          parent_tool_use_id: null,
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('blocks Codex file_change items while plan mode is active', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
          collaborationPolicy: ReturnType<typeof resolveCodexCollaborationPolicy>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
        collaborationPolicy: resolveCodexCollaborationPolicy({ planMode: 'on' }),
      };

      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'patch-1',
          type: 'file_change',
          changes: [{ path: 'src/app.ts', kind: 'update' }],
          status: 'completed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: 'sidecar_stream_status',
          mode_blocked: expect.objectContaining({
            effective_mode: 'plan',
            reason_code: 'plan_readonly_violation',
            request_id: 'patch-1',
          }),
        }),
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('blocks repo-mutating Codex commands while plan mode is active', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
          collaborationPolicy: ReturnType<typeof resolveCodexCollaborationPolicy>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
        collaborationPolicy: resolveCodexCollaborationPolicy({ planMode: 'on' }),
      };

      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.started',
        {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'git commit -m "ship"',
          aggregated_output: '',
          status: 'in_progress',
        },
        () => {},
      );
      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'git commit -m "ship"',
          aggregated_output: 'blocked',
          status: 'failed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: 'sidecar_stream_status',
          mode_blocked: expect.objectContaining({
            blocked_method: 'item/tool/commandExecution:git commit',
            effective_mode: 'plan',
          }),
        }),
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('uses the latest active Codex permissions when deciding whether to block plan mutations', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
          collaborationPolicy: ReturnType<typeof resolveCodexCollaborationPolicy>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
        collaborationPolicy: resolveCodexCollaborationPolicy({ planMode: 'on' }),
      };
      setActivePermissionState({
        sessionId: 'session-1',
        agentKind: 'codex',
        permissionConfig: {
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        },
        planMode: 'off',
      });

      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'patch-1',
          type: 'file_change',
          changes: [{ path: 'src/app.ts', kind: 'update' }],
          status: 'completed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_use',
                name: 'apply_patch',
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          type: 'user',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_result',
                tool_use_id: 'patch-1',
              }),
            ]),
          }),
        }),
      ]);
    } finally {
      clearActivePermissionState();
      stdoutSpy.mockRestore();
    }
  });

  it('emits Codex todo lists as state events instead of chat tool messages', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      const todoList = {
        id: 'todo-list-1',
        type: 'todo_list',
        items: [
          { text: 'Task 1', completed: true },
          { text: 'Task 2', completed: false },
        ],
      };

      emitItemEvent('session-1', 'item.started', todoList as any, () => {});
      emitItemEvent('session-1', 'item.completed', todoList as any, () => {});

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'codex_todo_list',
          session_id: 'session-1',
          todos: [
            { content: 'Task 1', status: 'completed' },
            { content: 'Task 2', status: 'pending' },
          ],
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('keeps global MCP helper tool names unprefixed for live rendering parity with history', () => {
    const toolUse = buildCodexToolUseContent({
      id: 'tool-1',
      type: 'mcp_tool_call',
      server: 'context7',
      tool: 'list_mcp_resources',
      arguments: { server: 'context7' },
      status: 'completed',
    } as any);

    expect(toolUse).toEqual({
      type: 'tool_use',
      id: 'tool-1',
      name: 'list_mcp_resources',
      input: { server: 'context7' },
    });
  });

  it('emits a structured diagnostic for unknown Codex approval-like events', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      await (runtime as unknown as {
        handleSdkEvent: (
          sessionId: string,
          event: ThreadEvent,
          emitFailure: (message: string) => void,
          noteStreamError: (message: string) => void,
        ) => Promise<void>;
      }).handleSdkEvent(
        'session-1',
        {
          type: 'approval.requested',
          request_id: 'approval-1',
          item: { id: 'approval-1', type: 'command_execution', command: 'git commit', status: 'pending' },
        } as unknown as ThreadEvent,
        () => {},
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'sidecar_stream_status',
          message: 'Codex emitted unsupported approval event type: approval.requested',
          is_reconnecting: false,
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('emits a compact boundary for live Codex compacted events', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      await (runtime as unknown as {
        handleSdkEvent: (
          sessionId: string,
          event: ThreadEvent,
          emitFailure: (message: string) => void,
          noteStreamError: (message: string) => void,
        ) => Promise<void>;
      }).handleSdkEvent(
        'session-1',
        {
          type: 'compacted',
          timestamp: '2026-07-03T17:22:53.471Z',
          payload: {
            message: 'Another language model started to solve this problem and produced a summary.',
          },
        } as unknown as ThreadEvent,
        () => {},
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          timestamp: '2026-07-03T17:22:53.471Z',
          session_id: 'session-1',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 0,
            post_tokens: 0,
          },
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
