import { isToolResultOnlyUserEvent } from '@/components/agent/assistant-ui/assistantCollapse';
import { isAskUserQuestionToolName } from '@/lib/askUserQuestionTools';
import { getToolDisplayName, getToolHeaderSummary } from '@/components/agent/toolHeaderSummary';
import { isSubagentToolName } from '@/lib/subagentTools';
import { isEphemeralLiveStreamNarrationEvent, type AgentMessage } from '@/stores/agentStore';
import type { ConversationTurn } from '@/types/conversationTurn';

/**
 * 处理段（activity run）分组：把一个回合里**连续的过程事件**（思考 / 工具）合成一段，
 * 文本片段与问询卡片等「非过程」事件切断分段。
 *
 * 这是展示层的纯投影：不改变事件顺序、不改变消息转换语义。渲染侧把同一段里的
 * 每个事件都画成缩进的步骤行，只有段首那一行画组头（图标 + 处理中/已处理 · 时间 + N 个步骤）。
 */

export type ActivityStepKind = 'thinking' | 'tool';

export type ActivityRun = {
  /** `${turnId}-${段首事件下标}`，段内稳定、跨渲染稳定。 */
  runKey: string;
  turnId: string;
  /** 段内事件的绝对下标（升序，连续）。 */
  eventIndices: number[];
  /** 与 eventIndices 等长：每个事件的过程类型（含工具的按工具算）。 */
  kinds: ActivityStepKind[];
  /** 段内实际会渲染出来的步骤数（一个事件可能含思考+工具两个步骤）。 */
  stepCount: number;
  startedAt?: number;
  endedAt?: number;
  /** 该段是「仍在运行的尾回合」的最后一段：未结束。 */
  live: boolean;
  /** 整段只有思考，没有工具调用——决定组头用「思考」还是「处理」措辞。 */
  onlyThinking: boolean;
  /** 段末步骤的单行摘要，用作运行中收起状态下的尾预览。 */
  /**
   * 整段都是委派（Task/Agent）调用：委派事件自成一段（像正文一样隔开左右两边的步骤组），
   * 段头画委派卡片而不是「已处理 N 个步骤」组头。
   */
  delegation: boolean;
  tail: string;
};

export type ActivityRunPlacement = {
  runKey: string;
  /** 该事件是否是所属段的段首（决定这一行画不画组头）。 */
  isHead: boolean;
  stepIndex: number;
  stepCount: number;
};

export type ActivityRuns = {
  runs: ActivityRun[];
  runByKey: Map<string, ActivityRun>;
  placementByEventIndex: Map<number, ActivityRunPlacement>;
};

export const EMPTY_ACTIVITY_RUNS: ActivityRuns = {
  runs: [],
  runByKey: new Map(),
  placementByEventIndex: new Map(),
};

type EventSteps = {
  kind: ActivityStepKind;
  stepCount: number;
  /**
   * 该事件同时含非空文本：文本**结束**这一段——分段循环在这里 flush，段后面的事件开新一段。
   * 参考实现里同一个消息的文本会被推成独立的文本气泡（`assistant-turns.ts` 的 `appendMessage`），
   * 所以「思考 + 答复」同在一个事件里时，思考仍属于它开启的段，段到文本为止；不在这里断开的话，
   * 文本后面的过程行会被并进同一段，那一段的组头就永远不会出现。
   */
  endsRun: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /**
   * 该事件里有委派（Task/Agent）工具调用。委派自成一类处理段：它既不开在普通步骤段里，
   * 也不接在普通步骤段后面，而是像正文那样把相邻的步骤组切开。
   */
  delegates: boolean;
  thinkingText?: string;
};

/**
 * 单个事件的「过程」判定。
 *
 * - 空思考、纯文本、纯工具结果的投影 → 不产生步骤（文本事件因此天然打断分段）；
 * - 含非空文本的过程事件仍然算过程，但会**终结**当段；
 * - 同时含思考与工具 → 按「含工具」归类，但步骤数各算一个，与渲染出来的行数一致。
 */
function classifyProcessEvent(event: AgentMessage | undefined): EventSteps | null {
  if (!event || event.kind !== 'assistant') {
    return null;
  }
  if (isEphemeralLiveStreamNarrationEvent(event)) {
    return null;
  }

  const content = event.data.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  let stepCount = 0;
  let hasTool = false;
  let delegates = false;
  let hasText = false;
  let toolName: string | undefined;
  let toolArgs: Record<string, unknown> | undefined;
  let thinkingText: string | undefined;

  for (const block of content) {
    if (!block) {
      continue;
    }

    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length > 0) {
        hasText = true;
      }
      continue;
    }

    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking.length > 0) {
        stepCount += 1;
        thinkingText = block.thinking;
      }
      continue;
    }

    if (block.type === 'tool_use') {
      stepCount += 1;
      hasTool = true;
      if (typeof block.name === 'string' && isSubagentToolName(block.name)) {
        delegates = true;
      }
      if (toolName === undefined) {
        toolName = typeof block.name === 'string' ? block.name : undefined;
        toolArgs = isRecord(block.input) ? block.input : undefined;
      }
    }
  }

  if (stepCount === 0) {
    return null;
  }


  return {
    kind: hasTool ? 'tool' : 'thinking',
    stepCount,
    delegates,
    endsRun: hasText,
    toolName,
    toolArgs,
    thinkingText,
  };
}

/**
 * 事件在对话流里是否**不画出任何一行**。
 *
 * 这类事件（工具结果、实时叙述草稿、转不出消息部分的助手事件）在渲染层被跳过，
 * 所以它们既不该开启一个处理段，也不该打断一个处理段：Claude/Codex 的流里
 * `assistant(tool_use)` ↔ `user(tool_result)` 交替出现，结果事件夹在两次工具调用之间，
 * 按事件切段会让同一个处理段凭空断成两段、各画一个组头（步骤数之和还等于全部步骤，
 * 读者却以为分了两波）。
 *
 * 判据取自 `convertAgentEventsToAssistantMessages` 的实际行为：只有 `user`、
 * `assistant`、`ask_user_question` 与 `visibleEventKinds` 里那几种事件会产出消息行。
 *
 * 少数事件是否落地成一行还取决于流的状态：`error` 会被折进上一个尚无结果的工具卡，
 * 由 `computeNoRowFlags` 按回合前向扫描后逐位覆盖。
 */
function rendersNoRow(event: AgentMessage | undefined): boolean {
  if (!event) {
    return true;
  }
  if (isEphemeralLiveStreamNarrationEvent(event)) {
    return true;
  }
  /**
   * 子智能体时间线把流式增量（`text_delta` / `reasoning_delta` / `content_started` /
   * `content_finished`）也原样留在事件序列里（主线程的同名事件由 `agentStore` 就地消费，
   * 从不进入 `events`），一个回合里这类事件能占九成以上。
   *
   * 它们一行都不画：内容已经落在聚合后的 `assistant_message` 里，
   * `convertAgentEventsToAssistantMessages` 对它们不产出任何消息行。所以它们既不该开段，
   * 也不该断段——按「不是 assistant 就画一行」处理会把每个内容块边界都当成断点，把同一个
   * 回合切成十几个「已处理 N 个步骤」组。
   */
  if (event.kind === 'streaming' || event.kind === 'streaming_batch') {
    return true;
  }
  // 工具结果只把结果贴回已有的工具卡，自己不画行（两种投影：独立 kind 与 user 消息）。
  if (event.kind === 'tool_result' || isToolResultOnlyUserEvent(event)) {
    return true;
  }
  // 只落成诊断 / 元数据的提供方事件（OpenCode 的 patch part、unknown part、进度、用量…）
  // 在对话流里不画行（渲染层只用它们算流状态与工具时长），所以它们夹在两个工具调用
  // 之间时不能把段切开——否则同一批工具会被拆成两组、各画一个组头。
  if (event.kind === 'raw') {
    return true;
  }
  // 回合收尾与问询超时事件只用来把结果 / 错误贴回已有卡片，同样从不产出新行。
  if (event.kind === 'result' || event.kind === 'ask_user_question_timeout') {
    return true;
  }
  if (event.kind !== 'assistant') {
    return false;
  }

  const content = event.data.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return true;
  }
  return content.every((block) => {
    if (!block) {
      return true;
    }
    if (block.type === 'text') {
      return typeof block.text !== 'string' || block.text.trim().length === 0;
    }
    if (block.type === 'thinking') {
      return typeof block.thinking !== 'string' || block.thinking.length === 0;
    }
    if (block.type === 'tool_use') {
      return false;
    }
    return true;
  });
}

/**
 * 按回合前向扫描，得到「这个位置的事件会不会画出一行」。
 *
 * 绝大多数事件只看种类即可（`rendersNoRow`），但 `error` 例外：`convertAgentEvents` 会把
 * 错误文本当成最近一个尚无结果的工具的结果贴上去（`attachLatestPendingToolError`），
 * 那种情况下这个事件一行都画不出来。它夹在相邻两次工具调用之间时不能把段切开——否则
 * 段头的步骤数会和行内可见的卡片数对不上，后一段的组头也没有行可以承载。
 * 判定条件必须和那个函数保持一致：有错误文本，且前面还有「已调用、没拿到结果」的工具。
 */
function computeNoRowFlags(turnEventIndices: number[], events: AgentMessage[]): boolean[] {
  const noRow: boolean[] = [];
  let pendingToolCalls = 0;

  for (const eventIndex of turnEventIndices) {
    const event = events[eventIndex];
    const errorText = event?.kind === 'error' && typeof event.data.error === 'string'
      ? event.data.error.trim()
      : '';
    if (errorText.length > 0 && pendingToolCalls > 0) {
      pendingToolCalls -= 1;
      noRow.push(true);
      continue;
    }

    const steps = classifyProcessEvent(event);
    if (steps !== null) {
      if (steps.kind === 'tool') {
        pendingToolCalls += 1;
      }
      noRow.push(false);
      continue;
    }

    // 结果的几种投影都只是把内容贴回已有卡片：独立 tool_result、只含结果的 user 消息、
    // 回合 result 与问询超时事件。
    if (
      event?.kind === 'tool_result'
      || event?.kind === 'result'
      || event?.kind === 'ask_user_question_timeout'
      || (event != null && isToolResultOnlyUserEvent(event))
    ) {
      pendingToolCalls = Math.max(0, pendingToolCalls - 1);
    }
    noRow.push(rendersNoRow(event));
  }

  return noRow;
}

function positiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 思考步骤的单行摘要：取最后一行，去掉标题与强调标记（对齐参考实现的尾预览）。 */
function thinkingTailLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^#+\s*|\*\*/g, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function stepsTailText(steps: EventSteps): string {
  if (steps.kind === 'tool' && steps.toolName) {
    const summary = getToolHeaderSummary(steps.toolName, steps.toolArgs ?? {});
    return summary.text ?? getToolDisplayName(steps.toolName);
  }
  return steps.thinkingText ? thinkingTailLine(steps.thinkingText) : '';
}

export function buildActivityRuns(
  events: AgentMessage[],
  turns: ConversationTurn<AgentMessage>[],
  timestamps: number[],
  options: ActivityRunOptions = {},
): ActivityRuns {
  const isRunning = options.isRunning ?? false;
  const lastTurnId = turns[turns.length - 1]?.id;
  const runs: ActivityRun[] = [];
  const runByKey = new Map<string, ActivityRun>();
  const placementByEventIndex = new Map<number, ActivityRunPlacement>();

  for (const turn of turns) {
    const turnEventIndices = turn.eventIndices;
    if (turnEventIndices.length === 0) {
      continue;
    }
    // 每个位置的事件会不会画出一行（含 `error` 被工具卡吸收这类与流状态相关的判定）。
    const noRow = computeNoRowFlags(turnEventIndices, events);

    // 段末的结束时间取「段后第一个事件」的时间戳——那才是这一步真正做完的时刻；
    // 段后没有事件时，未结束的尾段保持开放式计时，其余用回合末事件兜底。
    const turnLastIndex = turnEventIndices[turnEventIndices.length - 1];
    // 末尾那些不画行的事件不算「段之后还有内容」。
    let lastMeaningfulPos = -1;
    for (let pos = turnEventIndices.length - 1; pos >= 0; pos -= 1) {
      if (noRow[pos] !== true) {
        lastMeaningfulPos = pos;
        break;
      }
    }

    const closeRun = (runPositions: number[], delegation: boolean) => {
      const runEventIndices = runPositions.map((position) => turnEventIndices[position]);
      const runSteps: EventSteps[] = [];
      for (const eventIndex of runEventIndices) {
        const steps = classifyProcessEvent(events[eventIndex]);
        if (!steps) {
          return;
        }
        runSteps.push(steps);
      }

      const lastSteps = runSteps[runSteps.length - 1];
      // 以文本收尾的段（思考与最终答复同在一个事件里）已经做完：文本落地即不再「进行中」。
      const endsWithText = lastSteps?.endsRun === true;
      // 段后没有别的「会画出一行」的事件时，它才是这个回合的尾段。
      const lastPos = runPositions[runPositions.length - 1];
      const isLastRunOfTurn = lastPos === lastMeaningfulPos;
      const live = isRunning && isLastRunOfTurn && turn.id === lastTurnId && !endsWithText;
      const startedAt = positiveTimestamp(timestamps[runEventIndices[0]]);
      const nextIndex = turnEventIndices[lastPos + 1];
      const rawEndedAt = nextIndex !== undefined
        ? positiveTimestamp(timestamps[nextIndex])
        : (live ? undefined : positiveTimestamp(timestamps[turnLastIndex]));
      const endedAt = rawEndedAt !== undefined && startedAt !== undefined
        ? Math.max(startedAt, rawEndedAt)
        : undefined;

      const runKey = `${turn.id}-${runEventIndices[0]}`;
      const run: ActivityRun = {
        runKey,
        turnId: turn.id,
        eventIndices: runEventIndices,
        kinds: runSteps.map((steps) => steps.kind),
        stepCount: runSteps.reduce((total, steps) => total + steps.stepCount, 0),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        live,
        onlyThinking: runSteps.every((steps) => steps.kind === 'thinking'),
        delegation,
        tail: lastSteps ? stepsTailText(lastSteps) : '',
      };

      runs.push(run);
      runByKey.set(runKey, run);
      runEventIndices.forEach((eventIndex, stepIndex) => {
        placementByEventIndex.set(eventIndex, {
          runKey,
          isHead: stepIndex === 0,
          stepIndex,
          stepCount: run.stepCount,
        });
      });
    };

    let runPositions: number[] = [];
    // 当前这段是否全是委派调用：委派段与普通步骤段不合并，边界在段循环里判定。
    let runIsDelegation = false;
    const flushRun = () => {
      if (runPositions.length > 0) {
        closeRun(runPositions, runIsDelegation);
      }
      runPositions = [];
      runIsDelegation = false;
    };

    for (let pos = 0; pos < turnEventIndices.length; pos += 1) {
      const event = events[turnEventIndices[pos]];
      const steps = classifyProcessEvent(event);
      if (steps !== null) {
        // 委派事件自成一段：它像正文一样把左右两边的步骤组切开，不并进普通步骤段——否则
        // 段头画成委派卡片时，段内别的工具/思考会被一起收进那张卡片里。
        if (runPositions.length > 0 && steps.delegates !== runIsDelegation) {
          flushRun();
        }
        runPositions.push(pos);
        runIsDelegation = steps.delegates;
        // 以文本收尾的过程事件（「思考 + 答复」同在一个事件里）把段结在那里：文本下面是
        // 新的一段，不在这里断开的话前后两段会被并成一段，后面的段头也就不会出现。
        if (steps.endsRun) {
          flushRun();
        }
        continue;
      }
      // 不画任何行的事件（工具结果、实时叙述、被工具卡吸收的错误、空内容事件）既不属于段
      // 也不打断段：它们夹在两次工具调用之间时，两次调用仍属同一个处理段。
      if (noRow[pos] === true) {
        continue;
      }
      flushRun();
    }
    flushRun();
  }

  return { runs, runByKey, placementByEventIndex };
}

export type ActivityRunOptions = {
  /**
   * 会话是否正在运行。**不能**用回合状态代替：codeMUX 把「最后一个事件是仍有待结果的
   * 工具调用」的回合判为 interrupted，而流式过程中这正是常态。
   */
  isRunning?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 一条消息部分是否属于处理段的**过程步骤**（思考 / 普通工具调用）。
 *
 * 口径与线程 `GroupedParts` 的 `GROUP_BY_PART` 一致：问询卡片是独立部分、不参与分段，
 * 委派卡片把段内其余步骤收进卡片主体时也按这条判据挑行。
 */
export function isActivityRunPart(part: { type?: string; toolName?: string | null }): boolean {
  if (part.type === 'reasoning') return true;
  return part.type === 'tool-call' && !isAskUserQuestionToolName(part.toolName ?? '');
}

/**
 * 这一行之后，同一个处理段是否还有步骤。
 *
 * 一个处理段可以跨多个消息行（一边说一边调工具时，每个事件各成一行）：渲染层据此把跨行的
 * 行距压到与段内步距一致、并让段内的竖线接上下一行；否则每跨一行就多出一段空隙，竖线断开。
 */
export function rowRunContinues(
  placements: Map<number, ActivityRunPlacement>,
  run: ActivityRun | undefined,
  rowEventIndices: number[],
): boolean {
  if (run == null || run.eventIndices.length === 0) {
    return false;
  }
  let lastStepInRow = -1;
  for (const eventIndex of rowEventIndices) {
    const placement = placements.get(eventIndex);
    if (placement?.runKey === run.runKey) {
      lastStepInRow = Math.max(lastStepInRow, placement.stepIndex);
    }
  }
  return lastStepInRow >= 0 && lastStepInRow < run.eventIndices.length - 1;
}
