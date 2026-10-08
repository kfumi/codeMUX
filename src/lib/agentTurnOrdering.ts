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
    const trailing = normalized.slice(finalAssistantIndex + 1, resultIndex);
    const trailingProcess = trailing.filter((entry) => isReorderableProcessEvent(entry.event));
    if (trailingProcess.length === 0) {
      continue;
    }
    // 区间内不可重排的帧（如 session_summary）必须原位保留:它们夹在最终
    // assistant 与 result 之间是正常时序(sidecar 先发汇总再发 turn_finished)。
    // 原实现重组时只拼 trailingProcess,把这些帧静默丢掉,产物卡片随之永久消失。
    const others = trailing.filter((entry) => !isReorderableProcessEvent(entry.event));
    const beforeFinal = normalized.slice(userIndex, finalAssistantIndex);
    const finalAssistant = normalized[finalAssistantIndex]!;
    const result = normalized[resultIndex]!;

    normalized = [
      ...normalized.slice(0, userIndex),
      ...beforeFinal,
      ...trailingProcess,
      finalAssistant,
      ...others,
      result,
      ...normalized.slice(resultIndex + 1),
    ];
  }

  return normalized;
}
