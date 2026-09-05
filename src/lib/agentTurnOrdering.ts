import type { AgentMessage } from '@/stores/agentStore';
import { buildAssistantResultTargetMap, isHiddenAssistantThreadUserEvent } from '@/components/agent/assistant-ui/assistantResultTargets';

function isToolOnlyAssistantEvent(
  event: AgentMessage | undefined,
): event is Extract<AgentMessage, { kind: 'assistant' }> {
  if (event?.kind !== 'assistant') {
    return false;
  }
  const content = event.data?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block: { type?: string }) => block?.type === 'tool_use');
}

function isToolResultEvent(event: AgentMessage | undefined): boolean {
  return event?.kind === 'tool_result';
}

function isReorderableProcessEvent(event: AgentMessage | undefined): boolean {
  return isToolOnlyAssistantEvent(event) || isToolResultEvent(event);
}

function findTurnUserIndex(
  events: AgentMessage[],
  finalAssistantIndex: number,
  resultIndex: number,
): number | undefined {
  const searchStartIndex = Math.min(finalAssistantIndex, resultIndex) - 1;
  for (let index = searchStartIndex; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'user') {
      if (isHiddenAssistantThreadUserEvent(event)) {
        continue;
      }
      return index;
    }
  }
  return undefined;
}

/**
 * Pi live projection and OpenCode late narration can leave tool steps after the
 * final text assistant within the same turn. Move those trailing process events
 * before the final answer so compact output and tool groups stay above the result.
 */
export function normalizeTurnProcessEventOrder(events: AgentMessage[]): AgentMessage[] {
  return normalizeTurnProcessTimeline(events.map((event, index) => ({ event, ts: index })))
    .map((entry) => entry.event);
}

export function normalizeTurnProcessTimeline<T extends { event: AgentMessage; ts: number }>(
  timeline: T[],
): T[] {
  const events = timeline.map((entry) => entry.event);
  const resultTargets = buildAssistantResultTargetMap(events);
  if (resultTargets.size === 0) {
    return timeline;
  }

  const turnRanges: Array<{ userIndex: number; resultIndex: number; finalAssistantIndex: number }> = [];
  for (const [finalAssistantIndex, resultIndex] of resultTargets) {
    const userIndex = findTurnUserIndex(events, finalAssistantIndex, resultIndex);
    if (userIndex != null) {
      turnRanges.push({ userIndex, resultIndex, finalAssistantIndex });
    }
  }

  if (turnRanges.length === 0) {
    return timeline;
  }

  turnRanges.sort((left, right) => right.userIndex - left.userIndex);

  let normalized = [...timeline];
  for (const { userIndex, resultIndex, finalAssistantIndex } of turnRanges) {
    const trailingProcess = normalized
      .slice(finalAssistantIndex + 1, resultIndex)
      .filter((entry) => isReorderableProcessEvent(entry.event));
    if (trailingProcess.length === 0) {
      continue;
    }

    const beforeFinal = normalized.slice(userIndex, finalAssistantIndex);
    const finalAssistant = normalized[finalAssistantIndex]!;
    const result = normalized[resultIndex]!;

    normalized = [
      ...normalized.slice(0, userIndex),
      ...beforeFinal,
      ...trailingProcess,
      finalAssistant,
      result,
      ...normalized.slice(resultIndex + 1),
    ];
  }

  return normalized;
}
