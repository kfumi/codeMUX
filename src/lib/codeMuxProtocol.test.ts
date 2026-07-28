import { describe, expect, it } from 'vitest';
import { toLegacyAssistantMessage, toLegacyPermissionRequestedMessage, toLegacyStreamingMessage, toLegacyToolMessage, toLegacyTurnMessage, toLegacyUserInputRequestedMessage } from './codeMuxProtocol';

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

  it('maps tool lifecycle events to the existing assistant and tool result model', () => {
    expect(toLegacyToolMessage({
      type: 'tool_started', session_id: 'session-1', tool_use_id: 'tool-1', name: 'shell_command', input: { command: 'pwd' }, event_id: 'event-1',
    })).toMatchObject({
      kind: 'assistant',
      data: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'pwd' } }] } },
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
      type: 'assistant_message', session_id: 'session-1', event_id: 'event-3', content: [{ type: 'text', text: 'hello' }],
    })).toMatchObject({
      kind: 'assistant',
      data: { session_id: 'session-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
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
