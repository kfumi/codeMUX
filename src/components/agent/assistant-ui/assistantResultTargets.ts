import type { AgentMessage } from '../../../stores/agentStore';
import { isClaudeTaskNotificationUserEvent, isCodexCompactSummaryText } from '../../../stores/agentEventParsing';

export type AssistantResultTargetOptions = {
  allowImplicitResult?: boolean;
};

export function buildAssistantResultTargetSet(
  events: AgentMessage[],
  options: AssistantResultTargetOptions = {},
): Set<number> {
  return new Set(buildAssistantResultTargetMap(events, options).keys());
}

export function isHiddenAssistantThreadUserEvent(
  event: Extract<AgentMessage, { kind: 'user' }>,
): boolean {
  const text = typeof event.data.content === 'string' ? event.data.content.trim() : '';
  const data = event.data as Record<string, unknown>;

  return (
    isClaudeTaskNotificationUserEvent(data) ||
    isToolResultOnlyUserEvent(data) ||
    data.isCompactSummary === true ||
    data.isVisibleInTranscriptOnly === true ||
    isCodexCompactSummaryText(text) ||
    text === '/compact' ||
    /^<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>$/i.test(text)
  );
}

function isToolResultOnlyUserEvent(data: Record<string, unknown>): boolean {
  const message = data.message;
  if (!isRecord(message) || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }

  return message.content.every((block) => isRecord(block) && block.type === 'tool_result');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildAssistantResultTargetMap(
  events: AgentMessage[],
  options: AssistantResultTargetOptions = {},
): Map<number, number> {
  const targets = new Map<number, number>();
  const allowImplicitResult = options.allowImplicitResult ?? true;
  let preferredAssistantIndex: number | undefined;
  let pendingResultIndex: number | undefined;
  let sawAssistantSinceBoundary = false;

  const flushTurn = () => {
    if (preferredAssistantIndex != null && (pendingResultIndex != null || allowImplicitResult)) {
      const targetIndex = pendingResultIndex ?? preferredAssistantIndex;
      if (targetIndex != null) {
        targets.set(preferredAssistantIndex, targetIndex);
      }
    }
    pendingResultIndex = undefined;
    preferredAssistantIndex = undefined;
    sawAssistantSinceBoundary = false;
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index];

    if (event.kind === 'user') {
      if (!isHiddenAssistantThreadUserEvent(event)) {
        // Claude history can omit the SDK result line while still ending a
        // turn at the next real user message. Use the last assistant as the
        // implicit result anchor in that case.
        flushTurn();
      }
      continue;
    }

    if (event.kind === 'assistant') {
      sawAssistantSinceBoundary = true;
      if (getAssistantResultPriority(event) >= 1) {
        preferredAssistantIndex = index;
      }
      if (event.data.message?.stop_reason === 'end_turn') {
        pendingResultIndex = index;
      }
      continue;
    }

    if (event.kind === 'compact') {
      flushTurn();
      continue;
    }

    if (event.kind === 'result' && sawAssistantSinceBoundary) {
      pendingResultIndex = index;
    }
  }

  // A loaded session may end after the final assistant line because Claude's
  // result/system bookkeeping is not persisted in the JSONL transcript.
  flushTurn();

  return targets;
}

function getAssistantResultPriority(event: Extract<AgentMessage, { kind: 'assistant' }>): number {
  const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
  let hasTool = false;

  for (const block of blocks) {
    if ((block?.type === 'text' && block.text) || (block?.type === 'thinking' && block.thinking)) {
      return 2;
    }

    if (block?.type === 'tool_use') {
      hasTool = true;
    }
  }

  return hasTool && isOpenCodeAssistantEvent(event) ? 1 : 0;
}

function isOpenCodeAssistantEvent(event: Extract<AgentMessage, { kind: 'assistant' }>): boolean {
  const data = event.data as unknown as Record<string, unknown>;
  return typeof data.opencode_session_id === 'string' || typeof data.opencodeSessionId === 'string';
}
