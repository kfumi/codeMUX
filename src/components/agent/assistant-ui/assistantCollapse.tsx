import { useId } from 'react';

import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentMessage } from '@/stores/agentStore';
import { isEphemeralLiveStreamNarrationEvent } from '@/stores/agentStore';

import { buildAssistantResultTargetMap, isHiddenAssistantThreadUserEvent } from './assistantResultTargets';
import { hasExplicitFailureSignal } from './convertAgentEvents';
import { formatElapsed } from './RunningElapsed';

export type AssistantCollapseInfo = {
  turnKey: string;
  isToggleMessage: boolean;
  durationMs?: number;
  hideReasoningOnly?: boolean;
  /** 这一轮的过程步骤数：展开后能数出来的过程行（思考 / 工具 / 问询 / 异常…各算一步）。 */
  stepCount: number;
  /** 这一轮步骤里有工具异常：标题步骤数前的警示图标据此出现。 */
  hasError: boolean;
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
    const stepCount = countCollapsibleSteps(events, collapsibleEventIndices);
    const hasError = turnHasStepError(
      events,
      userIndex,
      Math.max(finalAssistantIndex, resultIndex),
      collapsibleEventIndices,
    );

    for (const eventIndex of collapsibleEventIndices) {
      collapseInfoByEventIndex.set(eventIndex, {
        turnKey,
        isToggleMessage: eventIndex === firstCollapsibleIndex,
        durationMs,
        hideReasoningOnly: eventIndex === finalAssistantIndex && finalAssistantHasReasoningAndText,
        stepCount,
        hasError,
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
  // 整轮标题要看得见秒：默认两档会把秒截掉（`2h 32m`），这里放开到三档。
  return formatElapsed(Math.max(0, ms), { maxParts: 3 });
}

export function AssistantCollapseToggle({
  expanded,
  durationMs,
  stepCount,
  hasError = false,
  onClick,
}: {
  expanded: boolean;
  durationMs?: number;
  stepCount?: number;
  hasError?: boolean;
  onClick: () => void;
}) {
  // 按钮带了 aria-label（动作名），按钮里的文字不再进入可访问名：状态改用 aria-describedby
  // 播报，否则读屏用户既听不到时长与步骤数，也听不到异常。
  const statusId = useId();
  const durationText = durationMs != null ? formatCompactDuration(durationMs) : '';
  const statusText = [
    durationText ? `已处理 ${durationText}` : '已处理',
    stepCount != null && stepCount > 0 ? `${stepCount} 个步骤` : '',
    hasError ? '过程步骤里有异常' : '',
  ].filter(Boolean).join('，');

  return (
    // 整轮开关是它领起的那块内容的标题：标题不画动作图标（正文里的过程行才带），
    // 时间与「已处理」同字号，步骤数小一号。层次靠两档文字色拉开：「已处理 + 时长」是主文字
    // （`text-foreground`），步骤数是次级文字（`text-muted-foreground`，显式写死，hover 时不
    // 跟着按钮变亮，两级对比始终在）。
    // 共享 Button 自带 `active:scale-[0.98]` 按压反馈，整行文字按下缩小、松开弹回，看起来像抖动：
    // 文字标题不要缩放，这里显式覆盖为不缩放。
    // 「已处理 + 时长」与「N 个步骤」字号不同（body/compact），flex 盒居中时小字段的行高盒
    // 也跟着缩小（19.5px vs 21px），基线会比大字上浮 ~1.25px，读起来不在一条水平线上（实测）。
    // 办法不是 items-baseline（文字组会贴行顶、图标反而偏下），而是给步骤数一个与主文字
    // 等高的行高盒（`leading-[calc(var(--text-ui-body)*1.5)]`）：两盒等高后盒居中即基线对齐
    // （基线差实测 0px），图标也随 items-center 回到几何中心。
    // 标题下始终留一条分隔线：展开与收起两种状态下「开关 → 下面内容」的距离必须一致，
    // 否则同一块内容会在两种状态之间跳动。
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-label={expanded ? '收起AI过程' : '展开AI过程'}
        aria-describedby={statusId}
        onClick={onClick}
        className="group/trigger -mx-[3px] h-auto min-h-[26px] max-w-full items-center gap-[5px] rounded-sm px-[5px] py-0 text-ui-body font-medium text-muted-foreground hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground active:scale-100"
      >
        <span
          data-slot="assistant-collapse-title"
          className="inline-flex shrink-0 items-center gap-[5px] text-foreground"
        >
          已处理
          {durationText ? (
            <span data-slot="assistant-collapse-duration" className="min-w-0 truncate tabular-nums">
              {durationText}
            </span>
          ) : null}
        </span>
        {hasError ? (
          <CircleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />
        ) : null}
        {stepCount != null && stepCount > 0 ? (
          <span
            data-slot="assistant-collapse-steps"
            className="min-w-0 truncate text-ui-compact tabular-nums leading-[calc(var(--text-ui-body)*1.5)] text-muted-foreground"
          >
            {stepCount} 个步骤
          </span>
        ) : null}
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span id={statusId} className="sr-only">{statusText}</span>
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

/**
 * 组内「步骤数」：数字要对得上展开后数得出来的过程行，所以逐条按「这个事件会不会画出一行」算。
 *
 * - 每个非空思考块、每个工具调用各一步；`text` 块是说明而不是动作，不计；
 * - 连续的重试事件在转换层被并进同一行（`updatePreviousApiRetryMessage`），只算一步；
 * - `error` 有错误文本、且前面还有没拿到结果的工具调用时会被折进那张工具卡（一行都不画），
 *   这时不算步骤，并且要把它所贴上的那个工具调用从「欠着结果」的计数里销掉；
 * - 助手已经发过同一个 `tool_use_id` 的问询工具调用时，问询事件不再单独建行，不算步。
 * - 同一个 `tool_use_id` 的重复投影是**同一次工具调用的输入刷新**（OpenCode 先发
 *   `input: {}` 的 pending 帧、再发补全 input 的 running 帧，各自新 `event_id`）：渲染层命中
 *   已有卡片就刷新参数、不再多画一行（`convertAgentEvents` 的 `resolveExistingToolCallPart`），
 *   所以这里也只算一步，且不重复计「欠着结果」的调用。
 */
function countCollapsibleSteps(events: AgentMessage[], collapsibleEventIndices: number[]): number {
  const firstIndex = collapsibleEventIndices[0];
  const lastIndex = collapsibleEventIndices[collapsibleEventIndices.length - 1];
  if (firstIndex === undefined || lastIndex === undefined) {
    return 0;
  }

  const inGroup = new Set(collapsibleEventIndices);
  let stepCount = 0;
  let pendingToolCalls = 0;
  let previousWasApiRetry = false;
  // 已计过步的工具身份：重复投影（输入刷新）不再计步，也不再算成「欠着结果」的一次调用。
  const seenToolUseIds = new Set<string>();

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    if (!inGroup.has(index)) {
      // 组外的夹层事件（工具结果、回合 result、流式增量…）不画过程行，但要把「工具调用还欠着
      // 结果」的状态销掉，否则后面的 error 会被误判成被工具卡吸收、白白少算一步。
      if (event.kind === 'tool_result' || event.kind === 'result' || isToolResultOnlyUserEvent(event)) {
        pendingToolCalls = Math.max(0, pendingToolCalls - 1);
      }
      continue;
    }

    const content = assistantContentBlocks(event);
    if (!content) {
      if (event.kind === 'api_retry') {
        if (!previousWasApiRetry) {
          stepCount += 1;
        }
        previousWasApiRetry = true;
        continue;
      }
      previousWasApiRetry = false;

      if (isAbsorbedErrorEvent(event, pendingToolCalls)) {
        pendingToolCalls = Math.max(0, pendingToolCalls - 1);
        continue;
      }

      if (event.kind === 'ask_user_question' && hasAssistantToolUseId(events, index, event.data.tool_use_id)) {
        continue;
      }

      stepCount += 1;
      continue;
    }

    previousWasApiRetry = false;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const toolUseId = typeof block.id === 'string' ? block.id : '';
        if (toolUseId.length > 0) {
          if (seenToolUseIds.has(toolUseId)) {
            continue;
          }
          seenToolUseIds.add(toolUseId);
        }
        stepCount += 1;
        pendingToolCalls += 1;
        continue;
      }
      if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        stepCount += 1;
      }
    }
  }

  return stepCount;
}

/**
 * 这一轮的步骤里是否有异常——标题上那个警示图标据此出现。
 *
 * 判据与渲染层同一套（工具卡是红的，标题就必须带图标）：
 * - 轮内带文本的 `error` 事件（提供方把工具失败折成错误文本时也在内）；
 * - 本轮工具调用拿到的失败结果：`is_error`，或 `hasExplicitFailureSignal` 认出的
 *   `exit_code` 非 0 / `success:false` 这类「内容即失败」的信号；
 * - 回合 `result` 报错：转换层会把它的文本贴到最后一个尚无结果的工具卡上。
 *
 * 结果必须按 `tool_use_id` 认领，否则会把上一轮工具的失败算到这一轮头上。
 */
function turnHasStepError(
  events: AgentMessage[],
  userIndex: number,
  lastIndex: number,
  collapsibleEventIndices: number[],
): boolean {
  const collapsibleToolUseIds = new Set<string>();
  for (const eventIndex of collapsibleEventIndices) {
    const content = assistantContentBlocks(events[eventIndex]);
    if (!content) {
      continue;
    }
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0) {
        collapsibleToolUseIds.add(block.id);
      }
    }
  }

  for (let index = userIndex + 1; index <= lastIndex; index += 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (event.kind === 'error') {
      if (typeof event.data.error === 'string' && event.data.error.trim().length > 0) {
        return true;
      }
      continue;
    }
    if (event.kind === 'result' && event.data.is_error === true) {
      if (typeof event.data.result === 'string' && event.data.result.trim().length > 0) {
        return true;
      }
      continue;
    }
    for (const result of getToolResultSignals(event)) {
      if (result.isError && collapsibleToolUseIds.has(result.toolUseId)) {
        return true;
      }
    }
  }

  return false;
}

function assistantContentBlocks(event: AgentMessage | undefined) {
  if (event?.kind !== 'assistant') {
    return undefined;
  }
  const content = event.data.message?.content;
  return Array.isArray(content) ? content : undefined;
}

/**
 * 工具结果的几处落地形态（独立 `tool_result` 事件、只含结果的 user 消息）里的失败信号。
 * 失败判据与渲染层共用，避免出现「卡片红、标题无图标」。
 */
function getToolResultSignals(event: AgentMessage): Array<{ toolUseId: string; isError: boolean }> {
  if (event.kind !== 'tool_result' && event.kind !== 'user') {
    return [];
  }

  const data = event.data as unknown as Record<string, unknown>;
  const signals: Array<{ toolUseId: string; isError: boolean }> = [];

  const message = data.message;
  if (isRecord(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        signals.push({
          toolUseId: block.tool_use_id,
          isError: block.is_error === true || hasExplicitFailureSignal(block.content),
        });
      }
    }
  }

  const toolUseResult = data.tool_use_result;
  if (isRecord(toolUseResult) && typeof toolUseResult.tool_use_id === 'string') {
    const rawResult = toolUseResult.content ?? toolUseResult.result;
    signals.push({
      toolUseId: toolUseResult.tool_use_id,
      isError: toolUseResult.is_error === true || hasExplicitFailureSignal(rawResult),
    });
  }

  return signals;
}

/** `error` 有文本、且前面还有没拿到结果的工具调用：转换层把它贴进那张工具卡，这个事件一行都不画。 */
function isAbsorbedErrorEvent(event: AgentMessage, pendingToolCalls: number): boolean {
  if (event.kind !== 'error') {
    return false;
  }
  const text = typeof event.data.error === 'string' ? event.data.error.trim() : '';
  return text.length > 0 && pendingToolCalls > 0;
}

/** 这个 `tool_use_id` 的工具调用是否已经在前面的事件里出现过（问询事件的去重判据）。 */
function hasAssistantToolUseId(
  events: AgentMessage[],
  eventIndex: number,
  toolUseId: string,
): boolean {
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    const content = assistantContentBlocks(events[index]);
    if (!content) {
      continue;
    }
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id === toolUseId) {
        return true;
      }
    }
  }
  return false;
}
