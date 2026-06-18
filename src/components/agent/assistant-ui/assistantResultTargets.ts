import type { AgentMessage } from '../../../stores/agentStore';

export function buildAssistantResultTargetSet(events: AgentMessage[]): Set<number> {
  return new Set(buildAssistantResultTargetMap(events).keys());
}

export function buildAssistantResultTargetMap(events: AgentMessage[]): Map<number, number> {
  const targets = new Map<number, number>();
  let fallbackAssistantIndex: number | undefined;
  let preferredAssistantIndex: number | undefined;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];

    if (event.kind === 'assistant') {
      const priority = getAssistantResultPriority(event);
      if (priority > 0) {
        fallbackAssistantIndex = index;
      }
      if (priority >= 2) {
        preferredAssistantIndex = index;
      }
      continue;
    }

    if (event.kind !== 'result') {
      continue;
    }

    const targetIndex = preferredAssistantIndex ?? fallbackAssistantIndex;
    if (targetIndex != null) {
      targets.set(targetIndex, index);
    }
    fallbackAssistantIndex = undefined;
    preferredAssistantIndex = undefined;
  }

  const trailingTargetIndex = preferredAssistantIndex ?? fallbackAssistantIndex;
  const lastTarget = getLastTarget(targets);
  const lastResultIndex = lastTarget != null ? targets.get(lastTarget) : undefined;

  if (
    trailingTargetIndex != null &&
    lastTarget != null &&
    lastResultIndex != null &&
    lastTarget < lastResultIndex &&
    lastResultIndex < trailingTargetIndex &&
    !hasUserMessageBetween(events, lastResultIndex, trailingTargetIndex)
  ) {
    targets.delete(lastTarget);
    targets.set(trailingTargetIndex, lastResultIndex);
  }

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

function getLastTarget(targets: Map<number, number>): number | undefined {
  let last: number | undefined;
  for (const target of targets.keys()) {
    last = target;
  }
  return last;
}

function hasUserMessageBetween(events: AgentMessage[], startExclusive: number, endInclusive: number): boolean {
  for (let index = startExclusive + 1; index <= endInclusive; index++) {
    if (events[index].kind === 'user') {
      return true;
    }
  }
  return false;
}
