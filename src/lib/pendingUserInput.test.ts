import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';
import type { AgentToolResult } from '../types/agent';
import {
  findLatestPendingUserQuestion,
  sessionAwaitsUserConfirmation,
} from './pendingUserInput';

const pendingQuestion: AgentMessage = {
  kind: 'ask_user_question',
  data: {
    tool_use_id: 'question-1',
    questions: [{
      question: '你写代码时更接近哪种习惯?',
      options: [{ label: '频繁调试' }],
    }],
  },
};

function toolResult(toolUseId: string): AgentMessage {
  const data: AgentToolResult = {
    type: 'user',
    uuid: 'tool-result-1',
    session_id: 'session-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
    parent_tool_use_id: null,
  };
  return { kind: 'tool_result', data };
}

describe('pendingUserInput', () => {
  it('detects a pending ask_user_question as awaiting confirmation', () => {
    expect(sessionAwaitsUserConfirmation([pendingQuestion])).toBe(true);
    expect(findLatestPendingUserQuestion([pendingQuestion])?.toolUseId).toBe('question-1');
  });

  it('clears pending state after a matching tool_result', () => {
    expect(sessionAwaitsUserConfirmation([pendingQuestion, toolResult('question-1')])).toBe(false);
  });

  it('clears pending state after timeout', () => {
    const events: AgentMessage[] = [
      pendingQuestion,
      {
        kind: 'ask_user_question_timeout',
        data: {
          tool_use_id: 'question-1',
          timeout_ms: 1000,
          message: 'timeout',
        },
      },
    ];

    expect(sessionAwaitsUserConfirmation(events)).toBe(false);
  });

  it('treats pending permissions as awaiting confirmation', () => {
    expect(sessionAwaitsUserConfirmation([], [{
      request_id: 'perm-1',
      permission_type: 'bash',
      description: 'run',
    }])).toBe(true);
  });

  it('ignores questions before a newer user message', () => {
    const events: AgentMessage[] = [
      pendingQuestion,
      { kind: 'user', data: { content: '继续' } },
    ];

    expect(sessionAwaitsUserConfirmation(events)).toBe(false);
  });
});
