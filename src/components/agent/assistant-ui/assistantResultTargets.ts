import type { AgentMessage } from '../../../stores/agentStore';
import { isClaudeTaskNotificationUserEvent, isCodexCompactSummaryText } from '../../../stores/agentEventParsing';

export function buildAssistantResultTargetSet(events: AgentMessage[]): Set<number> {
  return new Set(buildAssistantResultTargetMap(events).keys());
}

export function isHiddenAssistantThreadUserEvent(
  event: Extract<AgentMessage, { kind: 'user' }>,
): boolean {
  const text = typeof event.data.content === 'string' ? event.data.content.trim() : '';
  const data = event.data as Record<string, unknown>;

  return (
    isClaudeTaskNotificationUserEvent(data) ||
    data.isCompactSummary === true ||
    data.isVisibleInTranscriptOnly === true ||
    isCodexCompactSummaryText(text) ||
    text === '/compact' ||
    /^<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>$/i.test(text)
  );
}

export function buildAssistantResultTargetMap(events: AgentMessage[]): Map<number, number> {
  const targets = new Map<number, number>();
  let preferredAssistantIndex: number | undefined;
  let pendingResultIndex: number | undefined;
  let sawAssistantSinceBoundary = false;

  const flushPendingResult = () => {
    if (pendingResultIndex != null && preferredAssistantIndex != null) {
      targets.set(preferredAssistantIndex, pendingResultIndex);
    }
    pendingResultIndex = undefined;
    preferredAssistantIndex = undefined;
    sawAssistantSinceBoundary = false;
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index];

    if (event.kind === 'user') {
      if (!isHiddenAssistantThreadUserEvent(event)) {
        flushPendingResult();
      }
      continue;
    }

    if (event.kind === 'assistant') {
      sawAssistantSinceBoundary = true;
      if (getAssistantResultPriority(event) >= 2) {
        preferredAssistantIndex = index;
      }
      continue;
    }

    if (event.kind === 'compact') {
      flushPendingResult();
      continue;
    }

    if (event.kind === 'result' && sawAssistantSinceBoundary) {
      pendingResultIndex = index;
    }
  }

  flushPendingResult();

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

  return hasTool ? 1 : 0;
}
