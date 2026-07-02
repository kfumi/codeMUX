import { describe, expect, it } from 'vitest';

import {
  INTERRUPT_MARKER,
  isTerminalAgentEvent,
  isInterruptMarker,
  mapPersistedClaudeMessage,
  normalizeClaudeUserEvent,
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

  it('strips Codex collaboration policy blocks from live user text', () => {
    expect(
      parseSdkUserMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<codemux-codex-collaboration-policy>',
                'policy_version: codemux-codex-collaboration-policy/v1',
                'effective_mode: plan',
                '</codemux-codex-collaboration-policy>',
                '',
                'Design the feature.',
              ].join('\n'),
            },
          ],
        },
        parent_tool_use_id: null,
      }),
    ).toEqual({
      kind: 'user',
      data: { content: 'Design the feature.' },
    });
  });

  it('extracts Claude base64 image blocks as user attachments', () => {
    expect(
      parseSdkUserMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'who is this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: 'abc123',
              },
            },
          ],
        },
      }),
    ).toEqual({
      kind: 'user',
      data: {
        content: 'who is this',
        attachments: [
          {
            type: 'image',
            name: 'image-1.jpg',
            mediaType: 'image/jpeg',
            dataUrl: 'data:image/jpeg;base64,abc123',
          },
        ],
      },
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

  it('strips Codex collaboration policy blocks from persisted Codex user history', () => {
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
                  '<codemux-codex-collaboration-policy>',
                  'policy_version: codemux-codex-collaboration-policy/v1',
                  'profile: strict-local',
                  'effective_mode: plan',
                  '</codemux-codex-collaboration-policy>',
                  '',
                  'Design the feature.',
                ].join('\n'),
              },
            ],
          },
          parent_tool_use_id: null,
        },
        'codex',
      ),
    ).toEqual({
      kind: 'user',
      data: { content: 'Design the feature.' },
    });
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

  it('suppresses slash command meta messages (isMeta: true) from user-visible history', () => {
    expect(
      mapPersistedClaudeMessage(
        {
          type: 'user',
          isMeta: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  '`medium effort → 3+4 angles × 6 candidates → 1-vote verify → ≤8 findings`',
                  '',
                  'You are reviewing for **precision** at medium effort: every finding you surface',
                  'should be one a maintainer would act on.',
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

  it('suppresses Claude sidechain messages from main persisted history by default', () => {
    expect(
      mapPersistedClaudeMessage({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent-only text' }],
        },
      }),
    ).toBeNull();
  });

  it('keeps Claude sidechain messages when loading a subagent transcript', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'assistant',
        isSidechain: true,
        parent_tool_use_id: 'call_agent',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent-only text' }],
        },
      },
      'claude_code',
      { includeSidechain: true },
    );

    expect(event).toEqual({
      kind: 'assistant',
      data: expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'subagent-only text' }],
        }),
      }),
    });
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

  it('strips Claude CLI command XML tags and extracts the command name', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-message>code-review</command-message>\n<command-name>/code-review</command-name>',
            },
          ],
        },
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toEqual({
      kind: 'user',
      data: { content: '/code-review' },
    });
  });

  it('extracts command names from Claude command XML regardless of tag order', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<command-name>/compact</command-name>',
                '<command-message>compact</command-message>',
                '<command-args></command-args>',
              ].join('\n'),
            },
          ],
        },
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toEqual({
      kind: 'user',
      data: { content: '/compact' },
    });
  });

  it('normalizes live Claude command XML user events to command display text', () => {
    const event = normalizeClaudeUserEvent({
      kind: 'user',
      data: {
        content: [
          '<command-name>/compact</command-name>',
          '<command-message>compact</command-message>',
          '<command-args></command-args>',
        ].join('\n'),
      },
    });

    expect(event).toEqual({
      kind: 'user',
      data: { content: '/compact' },
    });
  });

  it('skips persisted Claude compact summary transcript-only messages', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context.',
        },
        isVisibleInTranscriptOnly: true,
        isCompactSummary: true,
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toBeNull();
  });

  it('skips persisted Claude local compact stdout messages', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>Compacted</local-command-stdout>',
        },
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toBeNull();
  });

  it('loads persisted Claude compact boundary events as compact markers', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 40956,
          postTokens: 2876,
        },
        uuid: 'compact-1',
        sessionId: 'session-1',
      },
      'claude_code',
    );

    expect(event).toEqual({
      kind: 'compact',
      data: expect.objectContaining({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: expect.objectContaining({
          trigger: 'manual',
          pre_tokens: 40956,
        }),
      }),
    });
  });

  it('strips Claude CLI command XML tags but keeps surrounding text', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please review this\n<command-message>code-review</command-message>\n<command-name>/code-review</command-name>',
            },
          ],
        },
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toEqual({
      kind: 'user',
      data: { content: 'Please review this' },
    });
  });

  it('leaves normal Claude Code user messages unchanged', () => {
    const event = mapPersistedClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'fix the bug in auth.ts',
            },
          ],
        },
        parent_tool_use_id: null,
      },
      'claude_code',
    );

    expect(event).toEqual({
      kind: 'user',
      data: { content: 'fix the bug in auth.ts' },
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
