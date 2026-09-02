import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentMessage } from '@/stores/agentStore';

import { buildAssistantResultTargetMap, isHiddenAssistantThreadUserEvent } from './assistantResultTargets';
import { formatElapsed } from './RunningElapsed';

export type AssistantCollapseInfo = {
  turnKey: string;
  isToggleMessage: boolean;
  durationMs?: number;
  hideReasoningOnly?: boolean;
};

export function buildAssistantCollapseInfoMap(
  events: AgentMessage[],
  timestamps: number[],
  options: { allowImplicitResult: boolean },
): Map<number, AssistantCollapseInfo> {
  const resultTargets = buildAssistantResultTargetMap(events, options);
  const collapseInfoByEventIndex = new Map<number, AssistantCollapseInfo>();

  for (const [finalAssistantIndex, resultIndex] of resultTargets) {
    const userIndex = findTurnUserIndex(events, finalAssistantIndex, resultIndex);
    if (userIndex == null) {
      continue;
    }

    const collapsibleEventIndices: number[] = [];
    for (let index = userIndex + 1; index < finalAssistantIndex; index++) {
      if (isCollapsibleProcessEvent(events[index])) {
        collapsibleEventIndices.push(index);
      }
    }

    // OpenCode can finish a turn with only a tool call and no narration.
    // Treat that final tool message as the collapsed process in that case.
    if (collapsibleEventIndices.length === 0 && isOpenCodeToolOnlyAssistantEvent(events[finalAssistantIndex])) {
      collapsibleEventIndices.push(finalAssistantIndex);
    }

    const finalAssistantHasReasoningAndText = hasAssistantReasoningAndText(events[finalAssistantIndex]);
    if (finalAssistantHasReasoningAndText) {
      collapsibleEventIndices.push(finalAssistantIndex);
    }

    if (collapsibleEventIndices.length === 0) {
      continue;
    }

    const turnKey = `${userIndex}-${finalAssistantIndex}-${resultIndex}`;
    const firstCollapsibleIndex = collapsibleEventIndices[0];
    const durationMs = getTurnDurationMs(events, timestamps, userIndex, finalAssistantIndex, resultIndex);

    for (const eventIndex of collapsibleEventIndices) {
      collapseInfoByEventIndex.set(eventIndex, {
        turnKey,
        isToggleMessage: eventIndex === firstCollapsibleIndex,
        durationMs,
        hideReasoningOnly: eventIndex === finalAssistantIndex && finalAssistantHasReasoningAndText,
      });
    }
  }

  return collapseInfoByEventIndex;
}

export function findLastVisibleUserEventIndex(events: AgentMessage[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'user' && !isHiddenAssistantThreadUserEvent(event)) {
      return index;
    }
  }
  return null;
}

export function omitLatestTurnCollapse(
  map: Map<number, AssistantCollapseInfo>,
  events: AgentMessage[],
): Map<number, AssistantCollapseInfo> {
  const lastUserIndex = findLastVisibleUserEventIndex(events);
  if (lastUserIndex == null) {
    return map;
  }

  const lastTurnKeyPrefix = `${lastUserIndex}-`;
  const filtered = new Map<number, AssistantCollapseInfo>();
  for (const [eventIndex, info] of map) {
    if (!info.turnKey.startsWith(lastTurnKeyPrefix)) {
      filtered.set(eventIndex, info);
    }
  }
  return filtered;
}

export function getCollapseInfoForSourceIndices(
  sourceEventIndices: number[],
  collapseInfoByEventIndex: Map<number, AssistantCollapseInfo>,
  options?: { hasReasoning?: boolean; isSplitHead?: boolean },
): AssistantCollapseInfo | undefined {
  let firstInfo: AssistantCollapseInfo | undefined;
  let hasToggleMessage = false;

  for (const sourceEventIndex of sourceEventIndices) {
    const info = collapseInfoByEventIndex.get(sourceEventIndex);
    if (!info) {
      continue;
    }

    firstInfo ??= info;
    hasToggleMessage = hasToggleMessage || info.isToggleMessage;
  }

  if (!firstInfo) {
    return undefined;
  }

  if (firstInfo.hideReasoningOnly && options?.hasReasoning !== true) {
    return undefined;
  }

  return {
    ...firstInfo,
    isToggleMessage: Boolean(hasToggleMessage && options?.isSplitHead !== false),
  };
}

export function formatCompactDuration(ms: number): string {
  return formatElapsed(Math.max(0, ms));
}

export function AssistantCollapseToggle({
  expanded,
  durationMs,
  onClick,
}: {
  expanded: boolean;
  durationMs?: number;
  onClick: () => void;
}) {
  return (
    <div className={expanded ? 'pb-2' : 'pb-1'}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-label={expanded ? '收起AI过程' : '展开AI过程'}
        onClick={onClick}
        className="h-auto gap-1.5 px-0 py-0 pl-1 text-sm font-medium text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground/80"
      >
        <span>已处理</span>
        {durationMs != null ? <span className="tabular-nums">{formatCompactDuration(durationMs)}</span> : null}
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </Button>
      {expanded ? <div className="mt-1.5 border-b border-border/40" /> : null}
    </div>
  );
}

export function isToolResultOnlyUserEvent(event: AgentMessage): boolean {
  if (event.kind !== 'user') return false;
  const data = event.data as Record<string, unknown>;
  const message = data.message;
  if (!isRecord(message) || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }

  return message.content.every((block) => isRecord(block) && block.type === 'tool_result');
}

function findTurnUserIndex(
  events: AgentMessage[],
  finalAssistantIndex: number,
  resultIndex: number,
): number | undefined {
  const searchStartIndex = Math.min(finalAssistantIndex, resultIndex) - 1;
  for (let index = searchStartIndex; index >= 0; index--) {
    const event = events[index];
    if (event.kind === 'user') {
      if (isToolResultOnlyUserEvent(event)) continue;
      return index;
    }
  }

  return undefined;
}

function isCollapsibleProcessEvent(event: AgentMessage | undefined): boolean {
  if (!event) {
    return false;
  }

  if (event.kind === 'assistant') {
    // Empty thinking does not become a visible message, so it cannot be the toggle.
    return hasRenderableAssistantContent(event);
  }

  return event.kind === 'ask_user_question'
    || event.kind === 'api_retry'
    || event.kind === 'compact'
    || event.kind === 'error'
    || event.kind === 'native_session_rebuilt'
    || event.kind === 'stream_status';
}

function hasRenderableAssistantContent(
  event: Extract<AgentMessage, { kind: 'assistant' }>,
): boolean {
  return event.data.message.content.some((block) => {
    if (block?.type === 'tool_use') {
      return true;
    }

    if (block?.type === 'text' || block?.type === 'thinking') {
      return typeof block.text === 'string'
        ? block.text.length > 0
        : typeof block.thinking === 'string' && block.thinking.length > 0;
    }

    return false;
  });
}

function isOpenCodeToolOnlyAssistantEvent(event: AgentMessage | undefined): boolean {
  if (event?.kind !== 'assistant') {
    return false;
  }

  const data = event.data as unknown as Record<string, unknown>;
  if (typeof data.opencode_session_id !== 'string' && typeof data.opencodeSessionId !== 'string') {
    return false;
  }

  const content = event.data.message?.content;
  return Array.isArray(content)
    && content.length > 0
    && content.every((block) => block?.type === 'tool_use');
}

function hasAssistantReasoningAndText(event: AgentMessage | undefined): boolean {
  if (event?.kind !== 'assistant') {
    return false;
  }

  const content = event.data.message?.content;
  return Array.isArray(content)
    && content.some((block) => block?.type === 'thinking')
    && content.some((block) => block?.type === 'text');
}

function getTurnDurationMs(
  events: AgentMessage[],
  timestamps: number[],
  userIndex: number,
  finalAssistantIndex: number,
  resultIndex: number,
): number | undefined {
  const result = events[resultIndex];
  if (result?.kind === 'result' && typeof result.data.duration_ms === 'number' && result.data.duration_ms > 0) {
    return result.data.duration_ms;
  }

  const startTime = timestamps[userIndex];
  const endTime = timestamps[resultIndex] || timestamps[finalAssistantIndex];
  if (typeof startTime === 'number' && startTime > 0 && typeof endTime === 'number' && endTime > startTime) {
    return endTime - startTime;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
