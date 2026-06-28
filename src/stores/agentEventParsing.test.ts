import { describe, expect, it } from 'vitest';

import {
  INTERRUPT_MARKER,
  isTerminalAgentEvent,
  isInterruptMarker,
  mapPersistedClaudeMessage,
  parseSdkUserMessage,
  shouldProcessTerminalEvent,
  shouldSuppressLiveEventWhileStopped,
} from './agentEventParsing';

describe('interrupt marker detection', () => {
  it('only matches the canonical interrupt marker', () => {
    expect(isInterruptMarker(INTERRUPT_MARKER)).toBe(true);
    expect(isInterruptMarker(' [Request interrupted by user] ')).toBe(true);
    expect(isInterruptMarker('request interrupted by user')).toBe(false);
  });
});

describe('parseSdkUserMessage', () => {
  it('keeps plain user text as a user event', () => {
    expect(
      parseSdkUserMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'stop here',
            },
          ],
        },
        parent_tool_use_id: null,
      }),
    ).toEqual({
      kind: 'user',
      data: { content: 'stop here' },
    });
  });

  it('keeps tool results as tool_result events', () => {
    const event = parseSdkUserMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'done',
          },
        ],
      },
      parent_tool_use_id: null,
    });

    expect(event.kind).toBe('tool_result');
  });
});

describe('mapPersistedClaudeMessage', () => {
  it('suppresses Codex injected AGENTS instructions from user-visible history', () => {
    expect(
      mapPersistedClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  '# AGENTS.md instructions for D:\\project\\ai-code\\codeMUX',
                  '',
                  '<INSTRUCTIONS>',
                  '# Repository Guidelines',
                  '',
                  'codeMUX is a Tauri 2 desktop app.',
                  '</INSTRUCTIONS>',
                ].join('\n'),
              },
            ],
          },
          parent_tool_use_id: null,
        },
        'codex',
      ),
    ).toBeNull();
  });

  it('suppresses Codex injected skill instructions from user-visible history', () => {
    expect(
      mapPersistedClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Base directory for this skill: C:\\Users\\94910\\.claude\\plugins\\cache\\claude-plugins-official\\superpowers\\5.1.0\\skills\\using-superpowers',
                  '',
                  '<SUBAGENT-STOP>',
                  'If you were dispatched as a subagent to execute a specific task, skip this skill.',
                  '</SUBAGENT-STOP>',
                  '',
                  '<EXTREMELY-IMPORTANT>',
                  'If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.',
                ].join('\n'),
              },
            ],
          },
          parent_tool_use_id: null,
        },
        'codex',
      ),
    ).toBeNull();
  });

  it('suppresses Claude Code injected skill instructions from user-visible history', () => {
    expect(
      mapPersistedClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Base directory for this skill: C:\\Users\\94910\\.claude\\plugins\\cache\\claude-plugins-official\\superpowers\\5.1.0\\skills\\using-superpowers',
                  '',
                  '<SUBAGENT-STOP>',
                  'If you were dispatched as a subagent to execute a specific task, skip this skill.',
                  '</SUBAGENT-STOP>',
                ].join('\n'),
              },
            ],
          },
          parent_tool_use_id: null,
        },
        'claude_code',
      ),
    ).toBeNull();
  });

  it('loads result messages from Claude JSONL history', () => {
    expect(
      mapPersistedClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: 'session-1',
        duration_ms: 10,
        duration_api_ms: 9,
        num_turns: 1,
        result: 'ok',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
        terminal_reason: 'completed',
      }),
    ).toEqual({
      kind: 'result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: 'session-1',
        duration_ms: 10,
        duration_api_ms: 9,
        num_turns: 1,
        result: 'ok',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
        terminal_reason: 'completed',
      },
    });
  });

  it('loads file snapshots from agent JSONL history', () => {
    expect(
      mapPersistedClaudeMessage({
        type: 'file_snapshot',
        file_path: 'D:\\project\\ai-code\\codeMUX\\src\\example.ts',
        original_content: 'before\n',
        is_new: false,
        tool_use_id: 'tool-1',
      }),
    ).toEqual({
      kind: 'file_snapshot',
      data: {
        type: 'file_snapshot',
        file_path: 'D:\\project\\ai-code\\codeMUX\\src\\example.ts',
        original_content: 'before\n',
        is_new: false,
        tool_use_id: 'tool-1',
      },
    });
  });
});

describe('shouldSuppressLiveEventWhileStopped', () => {
  it('suppresses visible post-stop events but still allows terminal bookkeeping events', () => {
    expect(shouldSuppressLiveEventWhileStopped('assistant')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('user')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('tool_result')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('result')).toBe(true);
    expect(shouldSuppressLiveEventWhileStopped('done')).toBe(false);
    expect(shouldSuppressLiveEventWhileStopped('error')).toBe(false);
  });
});

describe('terminal event helpers', () => {
  it('identifies done, error, and all result events as terminal events', () => {
    expect(isTerminalAgentEvent('done')).toBe(true);
    expect(isTerminalAgentEvent('error')).toBe(true);
    expect(isTerminalAgentEvent('result', true)).toBe(true);
    expect(isTerminalAgentEvent('result', false)).toBe(true);
    expect(isTerminalAgentEvent('assistant')).toBe(false);
  });

  it('ignores duplicate terminal events after the session already stopped', () => {
    expect(shouldProcessTerminalEvent(true, 'error')).toBe(true);
    expect(shouldProcessTerminalEvent(true, 'done')).toBe(true);
    expect(shouldProcessTerminalEvent(false, 'done')).toBe(false);
    expect(shouldProcessTerminalEvent(false, 'error')).toBe(false);
    expect(shouldProcessTerminalEvent(false, 'result', true)).toBe(false);
    expect(shouldProcessTerminalEvent(false, 'assistant')).toBe(true);
  });
});

describe('Codex runtime event normalization', () => {
  it('keeps non-Claude assistant payloads usable after runtime normalization', () => {
    const event = mapPersistedClaudeMessage({
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Codex says hello' }],
      },
      parent_tool_use_id: null,
    });

    expect(event).toEqual({
      kind: 'assistant',
      data: expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'Codex says hello' }],
        }),
      }),
    });
  });

  it('normalizes Codex result events the same way as Claude result events', () => {
    const event = mapPersistedClaudeMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-codex-1',
      session_id: 'session-codex-1',
      duration_ms: 5,
      duration_api_ms: 4,
      num_turns: 1,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(event).toEqual({
      kind: 'result',
      data: expect.objectContaining({
        uuid: 'result-codex-1',
        session_id: 'session-codex-1',
      }),
    });
  });
});
