import { describe, expect, it, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';

import { CodexSessionRuntime } from './codexRuntime.js';
import { buildCodexToolUseContent } from './runtimeEvents.js';

describe('CodexSessionRuntime', () => {
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

      const streamEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
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
});
