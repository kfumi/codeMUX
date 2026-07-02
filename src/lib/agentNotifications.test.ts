import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';
import {
  buildAgentNotificationCandidate,
  shouldDispatchAgentNotification,
} from './agentNotifications';

const sessionTitles = new Map<string, string>([['session-1', '重构设置页']]);

describe('agent notification rules', () => {
  it('builds a requires-input notification for ask_user_question events', () => {
    const event: AgentMessage = {
      kind: 'ask_user_question',
      data: {
        tool_use_id: 'question-1',
        questions: [{
          question: '是否继续执行命令？',
          options: [{ label: '继续' }, { label: '停止' }],
        }],
      },
    };

    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event,
      eventIndex: 3,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'requires_input:session-1:question-1',
      kind: 'requires_input',
      sessionId: 'session-1',
      title: '需要你的回复',
      body: '重构设置页：是否继续执行命令？',
    });
  });

  it('builds a completed notification for done events', () => {
    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event: { kind: 'done' },
      eventIndex: 8,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'terminal:session-1:done:8',
      kind: 'task_completed',
      sessionId: 'session-1',
      title: '任务已完成',
      body: '重构设置页',
    });
  });

  it('builds a failed notification for error events', () => {
    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event: { kind: 'error', data: { type: 'sidecar_error', error: 'stream disconnected' } },
      eventIndex: 9,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'terminal:session-1:error:9',
      kind: 'task_failed',
      sessionId: 'session-1',
      title: '任务失败',
      body: '重构设置页：stream disconnected',
    });
  });

  it('does not dispatch while app is active or system notifications are disabled', () => {
    const candidate = {
      key: 'terminal:session-1:done:8',
      kind: 'task_completed' as const,
      sessionId: 'session-1',
      title: '任务已完成',
      body: '重构设置页',
    };

    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: false,
      systemEnabled: true,
      alreadyDispatched: false,
    })).toBe(false);
    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: true,
      systemEnabled: false,
      alreadyDispatched: false,
    })).toBe(false);
  });

  it('does not dispatch duplicate notification keys', () => {
    const candidate = {
      key: 'requires_input:session-1:question-1',
      kind: 'requires_input' as const,
      sessionId: 'session-1',
      title: '需要你的回复',
      body: '重构设置页：是否继续执行命令？',
    };

    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: true,
      systemEnabled: true,
      alreadyDispatched: true,
    })).toBe(false);
  });
});
