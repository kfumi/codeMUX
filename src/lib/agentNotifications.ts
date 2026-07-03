import type { AgentMessage } from '../stores/agentStore';

export type AgentNotificationKind = 'requires_input' | 'task_completed' | 'task_failed';

export interface AgentNotificationCandidate {
  key: string;
  kind: AgentNotificationKind;
  sessionId: string;
  title: string;
  body: string;
}

interface CandidateInput {
  sessionId: string;
  event: AgentMessage;
  eventIndex: number;
  sessionTitles: Map<string, string>;
}

interface DispatchInput {
  candidate: AgentNotificationCandidate | null;
  isAppInactive: boolean;
  systemEnabled: boolean;
  alreadyDispatched: boolean;
}

function getSessionTitle(sessionId: string, sessionTitles: Map<string, string>): string {
  return sessionTitles.get(sessionId)?.trim() || 'AI 任务';
}

function compactBody(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getQuestionSummary(event: Extract<AgentMessage, { kind: 'ask_user_question' }>): string {
  const questions = event.data.questions;
  return compactBody(questions[questions.length - 1]?.question ?? '等待你的输入');
}

export function buildAgentNotificationCandidate({
  sessionId,
  event,
  eventIndex,
  sessionTitles,
}: CandidateInput): AgentNotificationCandidate | null {
  const sessionTitle = getSessionTitle(sessionId, sessionTitles);

  if (event.kind === 'ask_user_question') {
    return {
      key: `requires_input:${sessionId}:${event.data.tool_use_id}`,
      kind: 'requires_input',
      sessionId,
      title: '需要你的回复',
      body: compactBody(`${sessionTitle}：${getQuestionSummary(event)}`),
    };
  }

  if (event.kind === 'done') {
    return {
      key: `terminal:${sessionId}:done:${eventIndex}`,
      kind: 'task_completed',
      sessionId,
      title: '任务已完成',
      body: sessionTitle,
    };
  }

  if (event.kind === 'result') {
    const isError = Boolean(event.data?.is_error);
    const resultText = typeof event.data?.result === 'string' ? event.data.result : '';
    return {
      key: `terminal:${sessionId}:result:${eventIndex}`,
      kind: isError ? 'task_failed' : 'task_completed',
      sessionId,
      title: isError ? '任务失败' : '任务已完成',
      body: isError && resultText ? compactBody(`${sessionTitle}：${resultText}`) : sessionTitle,
    };
  }

  if (event.kind === 'error') {
    return {
      key: `terminal:${sessionId}:error:${eventIndex}`,
      kind: 'task_failed',
      sessionId,
      title: '任务失败',
      body: compactBody(`${sessionTitle}：${event.data.error}`),
    };
  }

  return null;
}

export function shouldDispatchAgentNotification({
  candidate,
  isAppInactive,
  systemEnabled,
  alreadyDispatched,
}: DispatchInput): boolean {
  return Boolean(candidate && isAppInactive && systemEnabled && !alreadyDispatched);
}
