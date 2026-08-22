import type { AgentMessage } from '../stores/agentStore';
import type { AgentPermissionRequest } from '../types/agent';

type AskUserQuestionEvent = Extract<AgentMessage, { kind: 'ask_user_question' }>;

export type PendingUserQuestion = {
  toolUseId: string;
  questions: AskUserQuestionEvent['data']['questions'];
};

function isToolResultPart(value: unknown): value is { type: 'tool_result'; tool_use_id: string } {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'tool_result'
    && typeof (value as { tool_use_id?: unknown }).tool_use_id === 'string'
  );
}

export function collectAnsweredToolUseIds(events: AgentMessage[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (event.kind !== 'tool_result') {
      continue;
    }

    const message = (event.data as unknown as { message?: { content?: unknown[] } }).message;
    for (const part of message?.content ?? []) {
      if (isToolResultPart(part)) {
        ids.add(part.tool_use_id);
      }
    }
  }

  return ids;
}

export function collectExpiredQuestionIds(events: AgentMessage[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (event.kind === 'ask_user_question_timeout') {
      ids.add(event.data.tool_use_id);
    }
  }

  return ids;
}

/**
 * Issue 12: request ids resolved from any surface (desktop or Mobile
 * Companion). A broadcast `permission_resolved` event lands in the timeline
 * and must dismiss the matching pending question card everywhere.
 */
export function collectResolvedRequestIds(events: AgentMessage[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (event.kind === 'permission_resolved') {
      ids.add(event.data.request_id);
    }
  }

  return ids;
}

/** Latest unanswered ask_user_question still blocking the current turn. */
export function findLatestPendingUserQuestion(
  events: AgentMessage[],
  dismissedIds: Set<string> = new Set(),
): PendingUserQuestion | null {
  const answeredIds = collectAnsweredToolUseIds(events);
  const expiredIds = collectExpiredQuestionIds(events);
  const resolvedIds = collectResolvedRequestIds(events);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'user') {
      return null;
    }
    if (event.kind !== 'ask_user_question') {
      continue;
    }

    const toolUseId = event.data.tool_use_id;
    if (answeredIds.has(toolUseId) || expiredIds.has(toolUseId) || dismissedIds.has(toolUseId) || resolvedIds.has(toolUseId)) {
      continue;
    }

    return {
      toolUseId,
      questions: event.data.questions,
    };
  }

  return null;
}

/** True when the session is blocked on a user question or permission approval. */
export function sessionAwaitsUserConfirmation(
  events: AgentMessage[],
  pendingPermissions: AgentPermissionRequest[] = [],
): boolean {
  if (pendingPermissions.length > 0) {
    return true;
  }
  return findLatestPendingUserQuestion(events) !== null;
}
