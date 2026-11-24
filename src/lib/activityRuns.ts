import { builtinMcpToolSegment } from '@/lib/builtinMcp';
import { isToolResultOnlyUserEvent } from '@/components/agent/assistant-ui/assistantCollapse';
import { isHiddenAssistantThreadUserEvent } from '@/components/agent/assistant-ui/assistantResultTargets';
import {
  isCodexCompactSummaryAssistantEvent,
  visibleEventKinds,
} from '@/components/agent/assistant-ui/convertAgentEvents';
import { isAskUserQuestionToolName } from '@/lib/askUserQuestionTools';
import { getToolDisplayName, getToolHeaderSummary, normalizeToolName } from '@/components/agent/toolHeaderSummary';
import { isSubagentToolName } from '@/lib/subagentTools';
import { isEphemeralLiveStreamNarrationEvent, type AgentMessage } from '@/stores/agentStore';
import type { ConversationTurn } from '@/types/conversationTurn';

/**
 * 处理段（activity run）分组：把一个回合里**连续的过程事件**（思考 / 工具）合成一段，
 * 文本片段与问询卡片等「非过程」事件切断分段。
 *
 * 这是展示层的纯投影：不改变事件顺序、不改变消息转换语义。渲染侧把同一段里的
 * 每个事件都画成缩进的步骤行，段首那一行画组头（折叠组的摘要 / 分类统计）。
 */

export type ActivityStepKind = 'thinking' | 'tool';

/** 一次普通工具调用的投影身份：段级分类统计与活动摘要都按它去重、取参。 */
export type ActivityToolCallRef = {
  /** 提供方按调用生成的 `tool_use_id`；缺失记 `''`（无法跨事件跟踪，各算一次）。 */
  toolUseId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
};

export type ActivityRun = {
  /** `${turnId}-${段首事件下标}`，段内稳定、跨渲染稳定。 */
  runKey: string;
  turnId: string;
  /** 段内事件的绝对下标（升序，连续）。 */
  eventIndices: number[];
  /** 与 eventIndices 等长：每个事件的过程类型（含工具的按工具算）。 */
  kinds: ActivityStepKind[];
  /**
   * 段内实际会渲染出来的步骤数（一个事件可能含思考 + 工具两个步骤）：同一个
   * `tool_use_id` 的重复投影只算一步，与渲染出来的行数一一对应。
   */
  stepCount: number;
  /**
   * 段内的普通工具调用（委派工具也在内，但委派段整体走独立卡片，不进分类统计）。
   * 同一 `tool_use_id` 只出现一次（回合级去重），参数取**最新**一次投影——OpenCode 的
   * pending 帧 `input: {}` 之后跟着补全 input 的 running 帧，统计要用补全后的参数。
   */
  toolCalls: ActivityToolCallRef[];
  /** 段内非空思考块总数（纯思考组的「N 段」口径）。 */
  thinkingBlocks: number;
  startedAt?: number;
  endedAt?: number;
  /** 该段是「仍在运行的尾回合」的最后一段：未结束。 */
  live: boolean;
  /** 整段只有思考，没有工具调用——决定组头用「思考」还是「处理」措辞。 */
  onlyThinking: boolean;
  /**
   * 段内最后一个**尚未拿到结果**的普通工具调用（按整段事件流的最新参数解析）。
   * 只有运行中的尾段会消费它；已完成段永远没有活动工具。
   */
  activeTool?: { toolName: string; toolArgs?: Record<string, unknown> };
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
  /** 该事件里的普通工具调用（含委派工具；按块序）。 */
  toolCalls: ActivityToolCallRef[];
  /** 非空 thinking 块数：每块一步，与渲染出来的思考行一一对应。 */
  thinkingBlocks: number;
  /** 按块序，最后一个可见步骤是否是工具调用（段尾预览取它而不是「第一个工具」）。 */
  tailIsTool: boolean;
  /**
   * 该事件同时含非空文本：文本**结束**这一段——分段循环在这里 flush，段后面的事件开新一段。
   * 参考实现里同一个消息的文本会被推成独立的文本气泡（`assistant-turns.ts` 的 `appendMessage`），
   * 所以「思考 + 答复」同在一个事件里时，思考仍属于它开启的段，段到文本为止；不在这里断开的话，
   * 文本后面的过程行会被并进同一段，那一段的组头就永远不会出现。
   */
  endsRun: boolean;
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
  let thinkingText: string | undefined;
  let tailIsTool = false;
  const toolCalls: ActivityToolCallRef[] = [];
  let thinkingBlocks = 0;

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
        thinkingBlocks += 1;
        thinkingText = block.thinking;
        tailIsTool = false;
      }
      continue;
    }

    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      // 问询工具是 Interactive Request：不并入过程段、不进统计（spec 边界）。
      // 它由问询卡片承载且恒可见（渲染层豁免）；只含问询块的事件没有过程步骤，
      // 会作为非过程事件切断分段。
      if (isAskUserQuestionToolName(name)) {
        continue;
      }
      stepCount += 1;
      hasTool = true;
      tailIsTool = true;
      if (isSubagentToolName(name)) {
        delegates = true;
      }
      toolCalls.push({
        toolUseId: typeof block.id === 'string' ? block.id : '',
        toolName: name,
        ...(isRecord(block.input) ? { toolArgs: block.input } : {}),
      });
    }
  }

  if (stepCount === 0) {
    return null;
  }


  return {
    kind: hasTool ? 'tool' : 'thinking',
    delegates,
    endsRun: hasText,
    thinkingText,
    toolCalls,
    thinkingBlocks,
    tailIsTool,
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
 * 判据与 `convertAgentEventsToAssistantMessages` 的分派互为镜像，且默认走白名单：只有
 * `user`（真用户消息）、`assistant`（转得出消息部分）、`ask_user_question` 与
 * `visibleEventKinds` 里那几种系统事件会产出消息行，**其余 kind 一律不画行**。逐个枚举
 * 「不画行」的 kind 追不上新增事件——漏掉一个（如 `file_snapshot`，Claude Code 每次文件
 * 修改后都发一个）就会把连续的工具调用切成一个个小段。
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
  if (event.kind === 'user') {
    // user 行只在「真用户消息」时落地：工具结果载体、隐藏元数据事件（任务通知、
    // compact 摘要、命令回显等）与空消息都不画行。
    if (isHiddenAssistantThreadUserEvent(event)) {
      return true;
    }
    const text = typeof event.data.content === 'string' ? event.data.content.trim() : '';
    return text.length === 0 && (event.data.attachments?.length ?? 0) === 0;
  }
  if (event.kind === 'assistant') {
    // Codex 的 compact 摘要助手事件整个不落地成行（转换分派直接 return）。
    if (isCodexCompactSummaryAssistantEvent(event)) {
      return true;
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
  // 其余 kind 走白名单：转换分派只为 `ask_user_question` 与 `visibleEventKinds` 里的系统
  // 事件产出消息行。`file_snapshot`、`todo_list`、`permission`、`system`、`ready`、`done`、
  // `mcp_status`、`proxy_status`、`resume_failed` 等一律不画行——尤其 `file_snapshot`，
  // Claude Code 每次文件修改后都会发一个，把它当行会把每个编辑工具都切成独立小段
  // （真实会话实测：108 步的回合被切成 15 段、每两步一个组头）。
  return event.kind !== 'ask_user_question'
    && !(visibleEventKinds as readonly AgentMessage['kind'][]).includes(event.kind);
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
export function thinkingTailLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^#+\s*|\*\*/g, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function stepsTailText(steps: EventSteps): string {
  // 段尾兜底摘要取**最后一个可见步骤**（按块序）：最后一块是思考就用思考尾行，
  // 是工具就用最后一个工具调用——而不是无脑取段末事件的第一个工具。
  if (!steps.tailIsTool) {
    return steps.thinkingText ? thinkingTailLine(steps.thinkingText) : '';
  }
  const call = steps.toolCalls[steps.toolCalls.length - 1];
  if (call && call.toolName) {
    const summary = getToolHeaderSummary(call.toolName, call.toolArgs ?? {});
    return summary.text ?? getToolDisplayName(call.toolName);
  }
  return steps.thinkingText ? thinkingTailLine(steps.thinkingText) : '';
}

/**
 * 活动工具的单行摘要：动作词 + 参数摘要（读起来像工具行，例如「读取 src/App.tsx」）。
 * 没有参数摘要时退回工具显示名。
 */
export function activityToolCallSummary(call: { toolName: string; toolArgs?: Record<string, unknown> }): string {
  if (!call.toolName) {
    return '';
  }
  const summary = getToolHeaderSummary(call.toolName, call.toolArgs ?? {});
  return summary.text ? `${getToolDisplayName(call.toolName)} ${summary.text}` : getToolDisplayName(call.toolName);
}

export function buildActivityRuns(
  events: AgentMessage[],
  turns: ConversationTurn<AgentMessage>[],
  timestamps: number[],
  options: ActivityRunOptions = {},
): ActivityRuns {
  const isRunning = options.isRunning ?? false;
  const lastTurnId = turns[turns.length - 1]?.id;
  // 已经拿到结果的工具身份（整段事件流一次性扫出）：还没拿到结果的才是「活动工具」。
  const settledToolUseIds = collectSettledToolUseIds(events);
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

    // 本回合已经计过步的 `tool_use` 身份：同一身份的后续事件是输入刷新，渲染层不再多画
    // 一行，计数也必须只算一步。id 由提供方按调用生成，不跨回合复用，所以逐回合重置。
    const countedToolUseIds = new Set<string>();
    // 同一工具身份的**最新**一次投影：OpenCode 先发 `input: {}` 的 pending 帧、再发补全
    // input 的 running 帧，段级统计与活动摘要要取补全后的参数。
    const latestToolCallById = new Map<string, ActivityToolCallRef>();
    const turnRunStart = runs.length;

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

      // 段内普通工具调用：回合级去重（同 id 的输入刷新不重复计），参数取最新投影。
      // stepCount 与 toolCalls 必须同遍构建：去重集合只能消费一次，否则先建的工具列表
      // 会把计数全部判重掉。
      const runToolCalls: ActivityToolCallRef[] = [];
      let thinkingBlocks = 0;
      let stepCount = 0;
      for (const steps of runSteps) {
        thinkingBlocks += steps.thinkingBlocks;
        stepCount += steps.thinkingBlocks;
        for (const call of steps.toolCalls) {
          if (call.toolUseId.length > 0) {
            if (countedToolUseIds.has(call.toolUseId)) {
              continue;
            }
            countedToolUseIds.add(call.toolUseId);
            stepCount += 1;
            runToolCalls.push(latestToolCallById.get(call.toolUseId) ?? call);
            continue;
          }
          stepCount += 1;
          runToolCalls.push(call);
        }
      }

      const runKey = `${turn.id}-${runEventIndices[0]}`;
      const run: ActivityRun = {
        runKey,
        turnId: turn.id,
        eventIndices: runEventIndices,
        kinds: runSteps.map((steps) => steps.kind),
        stepCount,
        toolCalls: runToolCalls,
        thinkingBlocks,
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
        // 记录每个工具身份的最新参数（pending 帧之后会被补全 input 的帧覆盖）。
        for (const call of steps.toolCalls) {
          if (call.toolUseId.length > 0) {
            latestToolCallById.set(call.toolUseId, call);
          }
        }
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

    // 回合构建完成后，为每段解析「活动工具」：段内最后一个还没拿到结果的普通工具调用。
    // 只有运行中的尾段会消费它；缺 id 的调用无法跨事件跟踪，交给尾预览兜底。
    for (let index = turnRunStart; index < runs.length; index += 1) {
      const run = runs[index]!;
      for (let callIndex = run.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
        const call = run.toolCalls[callIndex]!;
        if (call.toolUseId.length === 0 || settledToolUseIds.has(call.toolUseId)) {
          continue;
        }
        run.activeTool = {
          toolName: call.toolName,
          ...(call.toolArgs ? { toolArgs: call.toolArgs } : {}),
        };
        break;
      }
    }
  }

  return { runs, runByKey, placementByEventIndex };
}

/**
 * 收集整段事件流里已经拿到结果的工具身份：独立 `tool_result` 事件与只含结果的
 * user 消息两种投影。还没出现在这个集合里的 `tool_use_id` 才是「仍在运行」。
 */
function collectSettledToolUseIds(events: AgentMessage[]): Set<string> {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool_result') {
      const id = (event.data as unknown as Record<string, unknown>).tool_use_id;
      if (typeof id === 'string' && id.length > 0) {
        settled.add(id);
      }
      continue;
    }
    if (event.kind !== 'user') {
      continue;
    }
    const content = (event.data as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (
        isRecord(block)
        && block.type === 'tool_result'
        && typeof block.tool_use_id === 'string'
        && block.tool_use_id.length > 0
      ) {
        settled.add(block.tool_use_id);
      }
    }
  }
  return settled;
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

/**
 * 完成态组头的分类统计口径：四个固定类别，覆盖四个 Agent Kind 的内置工具与 MCP 工具。
 * 分类依据**规范化工具身份**（内置 MCP 先还原工具段），不依据中文显示名；未识别的一律
 * 归「其他」，既不打断分段，也不会从统计中消失。
 *
 * 这里的身份表与 `toolHeaderSummary.ts` 的显示名表各管一件事（分类 vs 展示名），刻意
 * 不互相引用：新增工具时两处各加一行，避免分类口径被显示名文案牵动。
 */
export type ActivityToolCategory = 'explore' | 'execute' | 'change' | 'other';

const EXPLORE_TOOL_NAMES = new Set([
  'Read',
  'NotebookRead',
  'LS',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'view_image',
]);

const EXECUTE_TOOL_NAMES = new Set([
  'Bash',
  'shell_command',
  'shell',
  'exec_command',
  'exec',
  'write_stdin',
  'js',
  'js_repl',
  'js_repl_reset',
  // 内置浏览器
  'browser_open',
  'browser_navigate',
  'browser_list',
  'browser_eval',
  'browser_screenshot',
  'browser_input',
  'browser_cdp',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_select',
  // 电脑控制
  'computer_windows',
  'computer_screenshot',
  'computer_save_screenshot',
  'computer_active_window',
  'computer_apps',
  'computer_elements',
  'computer_wait',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_paste',
  'computer_scroll',
  'computer_drag',
  'computer_set_value',
  'computer_launch',
]);

const CHANGE_TOOL_NAMES = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
]);

export function classifyToolCategory(toolName: string): ActivityToolCategory {
  const segment = builtinMcpToolSegment(toolName);
  const name = segment ?? normalizeToolName(toolName);
  if (CHANGE_TOOL_NAMES.has(name)) return 'change';
  if (EXPLORE_TOOL_NAMES.has(name)) return 'explore';
  if (EXECUTE_TOOL_NAMES.has(name)) return 'execute';
  return 'other';
}

/** 修改类工具的目标路径参数键：按命中顺序取第一个字符串值。 */
const CHANGE_PATH_ARG_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path'];

/**
 * 从修改类工具的参数中提取目标路径。常规写入/编辑取路径参数；`apply_patch` 从补丁
 * 文本里解析 `*** Add/Update/Delete File:` 目标（一次补丁可触及多个文件）。
 * 只读参数与结构化结果，不猜自然语言，也不访问文件系统。
 */
export function extractActivityChangePaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string[] {
  const segment = builtinMcpToolSegment(toolName);
  const name = segment ?? normalizeToolName(toolName);
  if (!CHANGE_TOOL_NAMES.has(name)) {
    return [];
  }

  if (name === 'apply_patch') {
    const patchText = typeof args?.input === 'string'
      ? args.input
      : typeof args?.patch === 'string' ? args.patch : '';
    if (!patchText) {
      return [];
    }
    const paths: string[] = [];
    for (const match of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/gim)) {
      const path = match[1]?.trim();
      if (path) {
        paths.push(path);
      }
    }
    return paths;
  }

  for (const key of CHANGE_PATH_ARG_KEYS) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return [value.trim()];
    }
  }
  return [];
}

/**
 * 修改路径的**纯词法**规范化：统一分隔符、处理 `.` / `..`，保留 Windows 盘符、UNC、
 * POSIX 根与相对路径语义。不要求文件在本机存在，规范化结果只用于去重。
 */
export function normalizeActivityFilePath(path: string): string {
  const joined = path.replace(/\\/g, '/');
  const rootMatch = joined.match(/^(\/\/[^/]+\/[^/]+|\/|[A-Za-z]:\/)/);
  // 根统一带尾分隔符：UNC 根（`//server/share`）本身不带，拼接时会丢掉那道斜线。
  const root = rootMatch
    ? (rootMatch[1].endsWith('/') ? rootMatch[1] : rootMatch[1] + '/')
    : '';
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!root) {
        parts.push('..');
      }
      continue;
    }
    parts.push(part);
  }
  // 绝对路径带尾分隔符，保证 `C:/a` 与 `C:/a/`（以及 `/a` 与 `/a/`）归并为同一个键。
  return root + parts.join('/') + (root && parts.length > 0 ? '/' : '');
}

export type ActivityRunCategoryCounts = {
  explore: number;
  execute: number;
  other: number;
  /** 规范化去重后的修改文件数。 */
  changeFiles: number;
  /** 无法识别路径的修改调用次数（补充显示，不伪造文件数）。 */
  changeUnresolvedCalls: number;
};

export function getActivityRunCategoryCounts(run: Pick<ActivityRun, 'toolCalls'>): ActivityRunCategoryCounts {
  const counts: ActivityRunCategoryCounts = {
    explore: 0,
    execute: 0,
    other: 0,
    changeFiles: 0,
    changeUnresolvedCalls: 0,
  };
  const changePaths = new Set<string>();
  for (const call of run.toolCalls) {
    const category = classifyToolCategory(call.toolName);
    if (category === 'change') {
      const paths = extractActivityChangePaths(call.toolName, call.toolArgs);
      if (paths.length === 0) {
        counts.changeUnresolvedCalls += 1;
        continue;
      }
      for (const path of paths) {
        changePaths.add(normalizeActivityFilePath(path));
      }
      continue;
    }
    if (category === 'explore') {
      counts.explore += 1;
      continue;
    }
    if (category === 'execute') {
      counts.execute += 1;
      continue;
    }
    counts.other += 1;
  }
  counts.changeFiles = changePaths.size;
  return counts;
}

/**
 * 组头的分类统计文案，动宾短句用全角逗号串接（对齐 ZCode：已探索 2 次，已执行 11 命令，
 * 已修改 1 文件）。顺序固定为「探索 → 执行 → 修改 → 其他」，零值省略；纯思考段显示
 * 「已思考 N 段」。不显示耗时，不显示失败标记。
 *
 * `extraThinkingBlocks` 计入尚未提交的实时思考：运行中的段展开时组头要报这份统计，
 * 实时那段思考也得算进去，否则「已思考 N 段」会永远慢半拍。
 */
export function activityRunCompletedText(
  run: Pick<ActivityRun, 'toolCalls' | 'thinkingBlocks'>,
  extraThinkingBlocks = 0,
): string {
  const thinkingBlocks = run.thinkingBlocks + Math.max(extraThinkingBlocks, 0);
  if (run.toolCalls.length === 0) {
    return `已思考 ${Math.max(thinkingBlocks, 1)} 段`;
  }
  const counts = getActivityRunCategoryCounts(run);
  const parts: string[] = [];
  if (counts.explore > 0) parts.push(`已探索 ${counts.explore} 次`);
  if (counts.execute > 0) parts.push(`已执行 ${counts.execute} 命令`);
  // 无路径的修改按调用次数补记，不伪造文件数，也不显示「（路径未知）」——那对读者
  // 没有行动价值；与有路径的修改并存时合成一句，避免出现两个「已修改」。
  if (counts.changeFiles > 0 && counts.changeUnresolvedCalls > 0) {
    parts.push(`已修改 ${counts.changeFiles} 文件、${counts.changeUnresolvedCalls} 次`);
  } else if (counts.changeFiles > 0) {
    parts.push(`已修改 ${counts.changeFiles} 文件`);
  } else if (counts.changeUnresolvedCalls > 0) {
    parts.push(`已修改 ${counts.changeUnresolvedCalls} 次`);
  }
  if (counts.other > 0) parts.push(`已处理 ${counts.other} 项`);
  return parts.length > 0 ? parts.join('，') : '已处理';
}
