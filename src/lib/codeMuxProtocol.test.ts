import { describe, expect, it } from 'vitest';
import { toLegacyAssistantMessage, toLegacyPermissionRequestedMessage, toLegacyStreamingMessage, toLegacySystemMessage, toLegacyToolMessage, toLegacyTurnMessage, toLegacyUserInputRequestedMessage, toLegacyUserMessage } from './codeMuxProtocol';

describe('CodeMUX frontend protocol adapter', () => {
  it('keeps domain deltas compatible with the internal streaming model', () => {
    expect(toLegacyStreamingMessage({
      type: 'text_delta',
      session_id: 'session-1',
      index: 1,
      text: 'hello',
    })).toEqual({
      kind: 'streaming',
      data: {
        session_id: 'session-1',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'hello' },
        },
      },
    });
  });

  it('restores tool input deltas for the existing tool input buffer', () => {
    expect(toLegacyStreamingMessage({
      type: 'tool_input_delta',
      session_id: 'session-1',
      index: 2,
      partial_json: '{"command":',
    })).toEqual({
      kind: 'streaming',
      data: {
        session_id: 'session-1',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"command":' },
        },
      },
    });
  });

  it('maps tool lifecycle events to the existing assistant and tool result model', () => {
    expect(toLegacyToolMessage({
      type: 'tool_started', session_id: 'session-1', opencode_session_id: 'opencode-session-1', tool_use_id: 'tool-1', name: 'shell_command', input: { command: 'pwd' }, event_id: 'event-1',
    })).toMatchObject({
      kind: 'assistant',
      data: { opencode_session_id: 'opencode-session-1', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'pwd' } }] } },
    });
    expect(toLegacyToolMessage({
      type: 'tool_finished', session_id: 'session-1', tool_use_id: 'tool-1', content: 'ok', is_error: false, event_id: 'event-2',
    })).toMatchObject({
      kind: 'tool_result',
      data: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] } },
    });
  });

  it('maps completed assistant content to the existing assistant model', () => {
    expect(toLegacyAssistantMessage({
      type: 'assistant_message', session_id: 'session-1', opencode_session_id: 'opencode-session-1', event_id: 'event-3', content: [{ type: 'text', text: 'hello' }],
    })).toMatchObject({
      kind: 'assistant',
      data: { session_id: 'session-1', opencode_session_id: 'opencode-session-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    });
  });

  it('maps restored user messages and preserves their locator fields', () => {
    expect(toLegacyUserMessage({
      type: 'user_message',
      session_id: 'session-1',
      content: [{ type: 'text', text: 'hello' }],
      provider_message_id: 'provider-user-1',
      line_index: 12,
      event_id: 'event-1',
    })).toEqual({
      kind: 'user',
      data: {
        content: 'hello',
        locator: {
          providerMessageId: 'provider-user-1',
          lineIndex: 12,
          role: 'user',
          textFingerprint: 'hello',
        },
      },
    });
  });

  it('maps restored compaction system events to the existing compact model', () => {
    expect(toLegacySystemMessage({
      type: 'system_event',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 42 },
      event_id: 'event-2',
    })).toEqual({
      kind: 'compact',
      data: {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 42 },
      },
    });
  });

  it('maps runtime switch system events to a dedicated seam with briefing', () => {
    expect(toLegacySystemMessage({
      type: 'system_event',
      subtype: 'runtime_switch',
      content: '已切换到 Codex。以下由该智能体继续。原生会话已重建，未共用上一驾驶席的 session ID。',
      from_kind: 'claude_code',
      to_kind: 'codex',
      briefing: '[CodeMUX runtime switch]\nPrevious driver: Claude Code.',
      event_id: 'event-switch',
    })).toEqual({
      kind: 'runtime_switch',
      data: {
        from_kind: 'claude_code',
        to_kind: 'codex',
        content: '已切换到 Codex。以下由该智能体继续。原生会话已重建，未共用上一驾驶席的 session ID。',
        briefing: '[CodeMUX runtime switch]\nPrevious driver: Claude Code.',
      },
    });
  });

  it('preserves file diffs from session summary system events', () => {
    expect(toLegacySystemMessage({
      type: 'system_event',
      subtype: 'session_summary',
      diffs: [{ file: 'index.html', patch: '--- index.html\n+++ index.html\n-old\n+new' }],
      event_id: 'event-summary',
    })).toEqual({
      kind: 'session_summary',
      data: {
        type: 'system',
        subtype: 'session_summary',
        diffs: [{ file: 'index.html', patch: '--- index.html\n+++ index.html\n-old\n+new' }],
        uuid: 'event-summary',
      },
    });
  });

  it('projects user input requests to the existing question model', () => {
    expect(toLegacyUserInputRequestedMessage({
      type: 'user_input_requested', tool_use_id: 'question-1', questions: [{ question: '继续吗？', options: [] }],
    })).toEqual({
      kind: 'ask_user_question',
      data: { tool_use_id: 'question-1', questions: [{ question: '继续吗？', options: [] }] },
    });
  });

  it('projects permission requests to the existing permission model', () => {
    expect(toLegacyPermissionRequestedMessage({
      type: 'permission_requested', request_id: 'permission-1', permission_type: 'read', description: '读取文件',
    })).toEqual({
      kind: 'permission',
      data: { request_id: 'permission-1', permission_type: 'read', description: '读取文件', permission_id: undefined, metadata: undefined },
    });
  });

  it('maps turn outcomes to the existing result model', () => {
    expect(toLegacyTurnMessage({
      type: 'turn_finished', session_id: 'session-1', outcome: 'failed', reason: 'network down', event_id: 'event-3',
    })).toMatchObject({
      kind: 'result',
      data: { subtype: 'failed', is_error: true, result: 'network down' },
    });
  });
});
