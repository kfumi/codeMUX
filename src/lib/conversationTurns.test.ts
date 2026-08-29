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
  usage?: Record<string, number>,
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
        ...(usage ? { usage } : {}),
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

function syntheticResult(isError = false): AgentMessage {
  return {
    kind: 'result',
    data: {
      type: 'result',
      subtype: isError ? 'interrupted' : 'success',
      is_error: isError,
      uuid: 'synthetic-result-1',
      session_id: 'session-1',
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      result: isError ? 'interrupted' : 'ok',
      synthetic: true,
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

  it('does not complete a freshly started turn via a stale synthetic boundary', () => {
    // The sidecar emits the previous continuation turn's synthesized boundary
    // right after the next sendInput — before any content of the new turn.
    const turns = buildConversationTurns([
      user('previous question'),
      assistant([{ type: 'text', text: 'previous answer' }], 'end_turn'),
      result(),
      user('follow-up question'),
      syntheticResult(),
    ], { isRunning: false });

    expect(turns).toHaveLength(2);
    expect(turns[0]?.status).toBe('completed');
    // The fresh turn only contains the optimistic user message plus the
    // stale boundary — it must not read as completed.
    expect(turns[1]?.status).not.toBe('completed');
    expect(turns[1]?.durationMs).toBeUndefined();
  });

  it('still settles a reloaded turn whose only result marker is synthetic', () => {
    const turns = buildConversationTurns([
      user('hello'),
      assistant([{ type: 'text', text: 'working' }]),
      assistant([{ type: 'text', text: 'summary after subagents' }]),
      syntheticResult(),
    ], { isRunning: false });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('completed');
    expect(turns[0]?.durationMs).toBeUndefined();
  });

  it('fills durationMs from user and last assistant timestamps when history has no result', () => {
    const userTs = Date.parse('2026-08-15T09:22:56.188Z');
    const thinkingTs = Date.parse('2026-08-15T09:24:21.074Z');
    const assistantTs = Date.parse('2026-08-15T09:24:21.552Z');
    const [turn] = buildConversationTurns([
      user('你是什么模型'),
      assistant([{ type: 'thinking', thinking: 'The user asked which model I am.' }], 'end_turn'),
      assistant([{ type: 'text', text: '我是 GLM-4.7 Flash' }], 'end_turn'),
    ], {
      isRunning: false,
      timestamps: [userTs, thinkingTs, assistantTs],
    });

    expect(turn).toMatchObject({
      status: 'completed',
      durationMs: 85_364,
    });
  });

  it('prefers result duration_ms over event timestamps', () => {
    const [turn] = buildConversationTurns([
      user('hello'),
      assistant([{ type: 'text', text: 'hi' }], 'end_turn'),
      result(false),
    ], {
      isRunning: false,
      timestamps: [
        Date.parse('2026-08-15T09:22:56.188Z'),
        Date.parse('2026-08-15T09:24:21.552Z'),
        Date.parse('2026-08-15T09:24:21.800Z'),
      ],
    });

    expect(turn?.durationMs).toBe(12_400);
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
  });

  it('does not let a tool error override a later successful result', () => {
    const [turn] = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
      toolResult('tool-1', true),
      result(false),
    ], { isRunning: false });

    expect(turn?.status).toBe('completed');
    expect(turn?.termination?.kind).toBe('completed');
  });

  it('completes after a tool error when the assistant ends the turn', () => {
    const [turn] = buildConversationTurns([
      user('run it'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
      toolResult('tool-1', true),
      assistant([{ type: 'text', text: 'The tool failed, but I handled it.' }], 'end_turn', {
        input_tokens: 99846,
        output_tokens: 18368,
      }),
    ], { isRunning: false });

    expect(turn).toMatchObject({
      status: 'completed',
      pendingToolIds: [],
      footerAnchorEventIndex: 3,
    });
  });

  it('keeps agent-level result errors as failed', () => {
    const [turn] = buildConversationTurns([
      user('run it'),
      result(true),
    ], { isRunning: false });

    expect(turn?.status).toBe('failed');
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
