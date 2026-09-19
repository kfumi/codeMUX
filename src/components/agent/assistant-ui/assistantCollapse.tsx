import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentMessage } from '@/stores/agentStore';
import { isEphemeralLiveStreamNarrationEvent } from '@/stores/agentStore';

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
    // 没有以总结性文本收尾的回合通常意味着异常中断/未正常完成:不折叠,直接展示过程。
    if (!hasAssistantSummaryText(events[finalAssistantIndex])) {
      continue;
    }

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

    // Pi can emit tool_started after the final assistant_message in the same turn.
    // Keep those trailing process rows inside the compact "已处理" group too.
    for (let index = finalAssistantIndex + 1; index < resultIndex; index++) {
      if (isCollapsibleProcessEvent(events[index])) {
        collapsibleEventIndices.push(index);
      }
    }

    const finalAssistantHasReasoningAndText = hasAssistantReasoningAndText(events[finalAssistantIndex]);
    if (finalAssistantHasReasoningAndText) {
      collapsibleEventIndices.push(finalAssistantIndex);
    }

    if (collapsibleEventIndices.length === 0) {
      continue;
    }

    const turnKey = `${userIndex}-${finalAssistantIndex}-${resultIndex}`;
    const firstCollapsibleIndex = collapsibleEventIndices.find((eventIndex) => (
      !isWhitespaceOnlyAssistantEvent(events[eventIndex])
    )) ?? collapsibleEventIndices[0];
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
    // 整轮开关是它领起的那块内容的标题：不加图标（正文里的过程行才带动作图标），
    // 时间与「已处理」同字号。标题下始终留一条分隔线：展开与收起两种状态下
    // 「开关 → 下面内容」的距离必须一致，否则同一块内容会在两种状态之间跳动。
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-label={expanded ? '收起AI过程' : '展开AI过程'}
        onClick={onClick}
        className="group/trigger -mx-[3px] h-auto min-h-[26px] max-w-full items-center gap-[5px] rounded-sm px-[5px] py-0 text-ui-body font-medium text-muted-foreground hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground"
      >
        <span className="inline-flex shrink-0 items-center">本轮处理</span>
        {durationMs != null ? (
          <span className="min-w-0 truncate tabular-nums">{formatCompactDuration(durationMs)}</span>
        ) : null}
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
      </Button>
      <div data-slot="assistant-collapse-divider" className="mt-1.5 border-b border-border/40" />
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
    if (isEphemeralLiveStreamNarrationEvent(event)) {
      return false;
    }
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

function isWhitespaceOnlyAssistantEvent(event: AgentMessage | undefined): boolean {
  if (event?.kind !== 'assistant') {
    return false;
  }

  const content = event.data.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }

  return content.every((block) => {
    if (block?.type === 'tool_use') {
      return false;
    }

    if (block?.type === 'text') {
      return typeof block.text !== 'string' || block.text.trim().length === 0;
    }

    if (block?.type === 'thinking') {
      return typeof block.thinking !== 'string' || block.thinking.trim().length === 0;
    }

    return false;
  });
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

function hasAssistantSummaryText(event: AgentMessage | undefined): boolean {
  if (event?.kind !== 'assistant') {
    return false;
  }

  const content = event.data.message?.content;
  return Array.isArray(content) && content.some((block) => (
    block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  ));
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
