import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/stores/agentStore';

import { buildConversationTurns } from './conversationTurns';

let assistantCount = 0;

function user(content: string, uuid = `user-${content}`): AgentMessage {
  return {
    kind: 'user',
    data: { content, locator: { providerMessageId: uuid, role: 'user', textFingerprint: content } },
  };
}

function assistant(
  content: Array<Record<string, unknown>>,
  stopReason?: string,
): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: `assistant-${++assistantCount}`,
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content,
        ...(stopReason ? { stop_reason: stopReason } : {}),
      },
      parent_tool_use_id: null,
    },
  };
}

function toolResult(toolUseId: string, isError = false): AgentMessage {
  return {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: `tool-result-${toolUseId}`,
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done', ...(isError ? { is_error: true } : {}) }],
      },
      parent_tool_use_id: null,
    },
  };
}

function result(isError = false): AgentMessage {
  return {
    kind: 'result',
    data: {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      uuid: 'result-1',
      session_id: 'session-1',
      duration_ms: 12400,
      duration_api_ms: 10000,
      num_turns: 1,
      result: isError ? 'runtime failed' : 'ok',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  };
}

describe('buildConversationTurns', () => {
  it('completes a user and assistant turn from an explicit end_turn', () => {
    const turns = buildConversationTurns([
      user('hello'),
      assistant([{ type: 'text', text: 'hi' }], 'end_turn'),
    ], { isRunning: false });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: 'completed', pendingToolIds: [] });
    expect(turns[0]?.footerAnchorEventIndex).toBe(1);
  });

  it('keeps tool use and tool result in one turn', () => {
    const turns = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
      toolResult('tool-1'),
      assistant([{ type: 'text', text: 'done' }], 'end_turn'),
    ], { isRunning: false });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.messages).toHaveLength(4);
    expect(turns[0]?.status).toBe('completed');
  });

  it('treats a raw user-role tool_result as part of the current turn', () => {
    const turns = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
      {
        kind: 'user',
        data: {
          content: '',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
          },
        },
      } as AgentMessage,
      assistant([{ type: 'text', text: 'done' }], 'end_turn'),
    ], { isRunning: false });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.pendingToolIds).toEqual([]);
    expect(turns[0]?.status).toBe('completed');
  });

  it('marks EOF with pending tools as interrupted', () => {
    const [turn] = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
    ], { isRunning: false });

    expect(turn?.status).toBe('interrupted');
    expect(turn?.pendingToolIds).toEqual(['tool-1']);
  });

  it('does not infer completion from usage when no terminal signal exists', () => {
    const partial = assistant([{ type: 'text', text: 'still working' }]);
    partial.data.message.usage = { input_tokens: 20, output_tokens: 4 };
    const [turn] = buildConversationTurns([
      user('partial'),
      partial,
    ], { isRunning: false });

    expect(turn?.status).toBe('interrupted');
    expect(turn?.usage).toBeUndefined();
  });

  it('gives failure precedence over a later successful result', () => {
    const [turn] = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
      toolResult('tool-1', true),
      result(false),
    ], { isRunning: false });

    expect(turn?.status).toBe('failed');
    expect(turn?.termination?.reason).toBe('done');
  });

  it('starts a new turn at a real user message and interrupts the old one', () => {
    const turns = buildConversationTurns([
      user('first'),
      assistant([{ type: 'text', text: 'partial' }]),
      user('second'),
    ], { isRunning: true });

    expect(turns.map((turn) => turn.status)).toEqual(['interrupted', 'running']);
  });

  it('does not split on tool results and retains unknown events as diagnostics', () => {
    const turns = buildConversationTurns([
      { kind: 'system', data: { type: 'system', subtype: 'init', uuid: 'init-1', session_id: 'session-1', tools: [], model: '', cwd: '', permissionMode: '' } },
      user('hello'),
      { kind: 'raw', data: { type: 'future_metadata', value: true } },
      toolResult('unknown-tool'),
      assistant([{ type: 'text', text: 'ok' }], 'end_turn'),
    ], { isRunning: false, retainRawEvents: true });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'unknown_event',
      'unmatched_tool_result',
    ]);
    expect(turns[0]?.rawEvents).toHaveLength(5);
  });
});
