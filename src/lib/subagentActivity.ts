import { formatElapsed } from '@/components/agent/assistant-ui/RunningElapsed';
import { buildActivityRuns } from '@/lib/activityRuns';
import { buildConversationTurns } from '@/lib/conversationTurns';
import { parseAgentEvent, type AgentMessage } from '@/stores/agentStore';
import type { SubagentDescriptor, SubagentStatus } from '@/stores/subagentStore';

/**
 * 委派（Task/Agent）卡片的数据投影：把子智能体 store 里的描述符 + 原始时间线事件
 * 压成「一个处理段里有哪几个子智能体、各自什么状态、跑了多久、走了几步」。
 *
 * 纯函数：不订阅 store、不读时钟（`now` 由调用方给，默认当前时间），因此时长、
 * 步骤数与状态文案都可以直接单测。
 */

export type SubagentActivityNode = {
  subagentId: string;
  /** `title` → 「未命名子智能体」。 */
  name: string;
  provider: string;
  /**
   * 事件里带出来的模型名：OpenCode 挂在 `assistant_message.model` 上，Claude 的侧链子
   * 智能体常年只调工具、不产文本，模型挂在 `tool_started.model` 上（见 sidecar 的
   * `claudeToolEvents.ts`）。取不到就是 `undefined`，展示层退回 `provider`
   * （`claude` / `opencode`），不留空、不崩。
   */
  model?: string;
  /** 运行中 / 已完成 / 失败 / 已取消。 */
  statusLabel: string;
  status: SubagentStatus;
  /** 描述（`description`，退回 `subtitle`）。 */
  detail: string;
  /** 终态节点的时长（首末事件之差）。运行中不落该字段，由展示层按秒自走。 */
  durationMs?: number;
  /** 首条时间线事件的时间戳：运行中的节点据此每秒推进时长。 */
  startedAt?: number;
  stepCount: number;
  /** 该子智能体仍在运行。 */
  live: boolean;
};

export type SubagentActivitySummary = {
  total: number;
  finished: number;
  running: number;
  /** 失败 + 已取消：两者都是「有问题」的终态，用来决定卡片文案。 */
  failed: number;
  startedAt?: number;
  /** 全部子智能体终态后的结束时刻。有子智能体仍在运行时**不落**该字段。 */
  endedAt?: number;
};

export type SubagentActivity = {
  nodes: SubagentActivityNode[];
  summary: SubagentActivitySummary;
};

export type SubagentActivityInput = {
  order: readonly string[];
  descriptors: Readonly<Record<string, SubagentDescriptor>>;
  /** 每个子智能体的原始时间线事件（按时间序）。 */
  events: Readonly<Record<string, readonly Record<string, unknown>[]>>;
};

export const SUBAGENT_UNNAMED_LABEL = '未命名子智能体';
export const SUBAGENT_WORKING_LABEL = 'Subagent 正在工作';
export const SUBAGENT_FINISHED_LABEL = 'Subagent 已完成';
export const SUBAGENT_FINISHED_WITH_ISSUES_LABEL = 'Subagent 完成，但存在问题';

const SUBAGENT_STATUS_LABELS: Record<SubagentStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

export function subagentStatusLabel(status: SubagentStatus): string {
  return SUBAGENT_STATUS_LABELS[status] ?? status;
}

export function subagentDisplayName(descriptor: SubagentDescriptor | undefined): string {
  const title = descriptor?.title?.trim();
  return title ? title : SUBAGENT_UNNAMED_LABEL;
}


/** 节点卡上的描述：`description` → `subtitle`。 */
export function subagentDetailText(descriptor: SubagentDescriptor | undefined): string {
  return descriptor?.description?.trim() || descriptor?.subtitle?.trim() || '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从原始时间线事件里取模型名。
 *
 * 防御式读取：`event.model` → `event.data?.model` → `event.message?.model`，三者都做
 * `typeof === 'string'` 校验，取第一个非空值；一个都没有就返回 `undefined`
 * （调用方退回显示 `provider`）。两种 provider 的载体不同：OpenCode 是
 * `assistant_message.model`，Claude 侧链是 `tool_started.model`（tool-use-only 帧不产
 * assistant_message）；这里只按字段名找，不关心事件类型，缺失也不留空、不抛错。
 */
export function subagentModelFromEvents(
  events: readonly Record<string, unknown>[],
): string | undefined {
  for (const event of events) {
    const candidates = [
      event?.model,
      asRecord(event?.data)?.model,
      asRecord(event?.message)?.model,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }
  return undefined;
}

export function formatSubagentDuration(durationMs: number | undefined): string {
  return durationMs == null ? '' : formatElapsed(Math.max(0, durationMs));
}

function eventTimestamp(event: Record<string, unknown> | undefined): number | undefined {
  if (!event) return undefined;
  const raw = event.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function timelineBounds(timeline: readonly Record<string, unknown>[]): {
  startedAt?: number;
  endedAt?: number;
} {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const event of timeline) {
    const ts = eventTimestamp(event);
    if (ts === undefined) continue;
    if (startedAt === undefined) startedAt = ts;
    endedAt = ts;
  }
  return { startedAt, endedAt };
}

/**
 * 步骤数：与子智能体预览面板同一套投影（`parseAgentEvent` + `buildActivityRuns`），
 * 把该子智能体时间线里所有处理段的步骤数加起来。
 *
 * 缓存按**子智能体 id** 记，而不是按时间线数组身份：store 每次追加都换一个全新数组
 * （React 只能靠新身份感知变化），按身份命中的缓存于是每来一个 delta 就 miss 一次，
 * 把整条时间线重新 `parseAgentEvent` + `buildConversationTurns` + `buildActivityRuns`
 * 一遍。子智能体密集吐字时这条链是 O(n²) 次解析，主线程被占满、连计时器一起停跳。
 *
 * 所以条目里额外记住前缀数组本身：只要本次是「旧前缀逐位同引用 + 只追加了流式增量」，
 * 就直接复用旧计数。指针比较同样 O(n) 但不做任何解析，比重新投影便宜两三个数量级。
 */
type StepCountCacheEntry = {
  /** 上次计数的数组，下次做前缀比对用。 */
  array: readonly Record<string, unknown>[];
  count: number;
};

/** 防呆上限：真正会密集吐字的只有当前这几个子智能体。 */
const STEP_COUNT_CACHE_LIMIT = 32;
const stepCountCache = new Map<string, StepCountCacheEntry>();

function rememberStepCount(
  subagentId: string,
  array: readonly Record<string, unknown>[],
  count: number,
): void {
  // 命中已有键时 delete 再 set，让插入顺序始终反映最近使用，淘汰时丢的是最老的。
  stepCountCache.delete(subagentId);
  stepCountCache.set(subagentId, { array, count });
  while (stepCountCache.size > STEP_COUNT_CACHE_LIMIT) {
    const oldest = stepCountCache.keys().next();
    if (oldest.done) break;
    stepCountCache.delete(oldest.value);
  }
}

/**
 * 纯流式增量事件：`rendersNoRow`（`activityRuns.ts:193-205`）已把这一组判为「不画行」，
 * `classifyProcessEvent` 又只认 `assistant`，`buildConversationTurns` 对它们只 push 不开关
 * 回合 —— 三者合起来保证：追加它们既不增加步骤、也不开段断段，步骤数必然不变。
 *
 * 判据刻意保守：不在名单里的一律当作「可能改变步骤数」，触发全量重算。工具入参的就地
 * 刷新（`subagentStore` 的 `mergeToolRefresh` 会换掉中间某个元素的对象）也因此自动落到
 * 全量重算那一侧。
 */
function isPureStreamEvent(event: Record<string, unknown> | undefined): boolean {
  const type = event?.type;
  return type === 'text_delta'
    || type === 'reasoning_delta'
    || type === 'content_started'
    || type === 'content_finished';
}

/** 新数组是否是旧数组的纯流式追加：旧前缀逐位同引用，且新增项全是流式增量。 */
function isPureStreamExtension(
  timeline: readonly Record<string, unknown>[],
  previous: readonly Record<string, unknown>[],
): boolean {
  if (timeline.length <= previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (timeline[index] !== previous[index]) return false;
  }
  for (let index = previous.length; index < timeline.length; index += 1) {
    if (!isPureStreamEvent(timeline[index])) return false;
  }
  return true;
}

function timelineStepCount(
  subagentId: string,
  timeline: readonly Record<string, unknown>[],
): number {
  if (timeline.length === 0) return 0;
  const cached = stepCountCache.get(subagentId);
  if (cached && isPureStreamExtension(timeline, cached.array)) {
    return cached.count;
  }
  let stepCount = 0;
  try {
    const parsed = timeline.map((event) => parseAgentEvent(event));
    const timestamps = timeline.map((event) => eventTimestamp(event) ?? 0);
    const runs = buildActivityRuns(
      parsed,
      buildConversationTurns(parsed, { isRunning: false }),
      timestamps,
      { isRunning: false },
    );
    stepCount = runs.runs.reduce((total, run) => total + run.stepCount, 0);
  } catch {
    // 时间线里出现无法解析的事件时只丢步骤数，卡片的其余信息照常展示。
    stepCount = 0;
  }
  rememberStepCount(subagentId, timeline, stepCount);
  return stepCount;
}

export function buildSubagentActivity({
  order,
  descriptors,
  events,
}: SubagentActivityInput): SubagentActivity {
  const nodes: SubagentActivityNode[] = [];
  let startedAt: number | undefined;
  let endedAt: number | undefined;

  for (const subagentId of order) {
    const descriptor = descriptors[subagentId];
    if (!descriptor) continue;
    const timeline = events[subagentId] ?? [];
    const live = descriptor.status === 'running';
    const { startedAt: first, endedAt: last } = timelineBounds(timeline);
    // 运行中的子智能体**没有结束时刻**：时长由展示层按 `now - startedAt` 每秒自走
    // （`subagent-activity.tsx` 的组头与节点卡都是这个口径），所以这里对 live 节点
    // 既不落 `durationMs` 也不落 `endedAt`。这不是省事：尾部还在源源不断进来的
    // `text_delta` 每来一个就会改掉「最后一条事件时间戳」，若把它算进投影，子智能体
    // 每吐一个字都会换掉整张卡片的活动对象，进而让主线程每一行已挂载消息重新协调
    // （`CodeMuxThread` 的 render context 换身份）。终态才落这两个字段。
    const end = live ? undefined : last;
    const durationMs = first === undefined || end === undefined
      ? undefined
      : Math.max(0, end - first);
    const model = subagentModelFromEvents(timeline);

    nodes.push({
      subagentId,
      name: subagentDisplayName(descriptor),
      provider: descriptor.provider,
      ...(model !== undefined ? { model } : {}),
      statusLabel: subagentStatusLabel(descriptor.status),
      status: descriptor.status,
      detail: subagentDetailText(descriptor),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(first !== undefined ? { startedAt: first } : {}),
      stepCount: timelineStepCount(subagentId, timeline),
      live,
    });

    if (first !== undefined) {
      startedAt = startedAt === undefined ? first : Math.min(startedAt, first);
    }
    // 同上：live 节点的「结束」时刻无意义，只有终态才参与汇总（见上面的说明）。
    if (last !== undefined && !live) {
      endedAt = endedAt === undefined ? last : Math.max(endedAt, last);
    }
  }
  return {
    nodes,
    summary: {
      total: nodes.length,
      // 「已完成 x/N」与参考实现同口径：不再运行即计入（失败/取消也算「做完了」，
      // 它们另由 `failed` 表达，卡片文案会变成「完成，但存在问题」）。
      finished: nodes.filter((node) => !node.live).length,
      running: nodes.filter((node) => node.live).length,
      failed: nodes.filter((node) => node.status === 'failed' || node.status === 'canceled').length,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    },
  };
}

/** 卡片头部文案：运行中 / 已完成 / 有问题。 */
export function subagentActivityLabel(
  summary: Pick<SubagentActivitySummary, 'failed'>,
  live: boolean,
): string {
  if (live) return SUBAGENT_WORKING_LABEL;
  return summary.failed > 0 ? SUBAGENT_FINISHED_WITH_ISSUES_LABEL : SUBAGENT_FINISHED_LABEL;
}

/** 按父工具调用 id 找子智能体：描述符的 key 或 `toolCallId` 命中都算。 */
export function findSubagentIdByToolCallId(
  descriptors: Readonly<Record<string, SubagentDescriptor>>,
  toolCallId: string | null | undefined,
): string | undefined {
  if (!toolCallId) return undefined;
  if (descriptors[toolCallId]) return toolCallId;
  for (const [subagentId, descriptor] of Object.entries(descriptors)) {
    if (descriptor?.toolCallId === toolCallId) return subagentId;
  }
  return undefined;
}

/** 一组父工具调用 id 对应的子智能体，按描述符到达顺序（`order`）排列。 */
export function subagentIdsForToolCallIds(
  toolCallIds: Iterable<string>,
  order: readonly string[],
  descriptors: Readonly<Record<string, SubagentDescriptor>>,
): string[] {
  const wanted = new Set(toolCallIds);
  if (wanted.size === 0) return [];
  const ids: string[] = [];
  for (const subagentId of order) {
    const descriptor = descriptors[subagentId];
    if (!descriptor) continue;
    const toolCallId = descriptor.toolCallId ?? subagentId;
    if (typeof toolCallId === 'string' && wanted.has(toolCallId)) ids.push(subagentId);
  }
  return ids;
}

function collectToolUseIds(event: AgentMessage | undefined, into: Set<string>): void {
  if (!event || event.kind !== 'assistant') return;
  const content = event.data.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0) {
      into.add(block.id);
    }
  }
}

export type SubagentActivityRunsInput = {
  /** 处理段（连续思考 + 工具）与其事件下标。 */
  runs: readonly { runKey: string; eventIndices: readonly number[] }[];
  agentEvents: readonly AgentMessage[];
  order: readonly string[];
  descriptors: Readonly<Record<string, SubagentDescriptor>>;
  subagentEvents: Readonly<Record<string, readonly Record<string, unknown>[]>>;
};

/**
 * 每个处理段里的委派：段内事件调用过哪些父工具、其中哪些真的起了子智能体。
 *
 * 只有含委派的段才会出现在结果里——线程据此决定段头画委派卡片还是普通组头。
 */
export function buildRunSubagentActivity(
  input: SubagentActivityRunsInput,
): Map<string, SubagentActivity> {
  const byRunKey = new Map<string, SubagentActivity>();
  if (input.order.length === 0) return byRunKey;

  for (const run of input.runs) {
    const toolCallIds = new Set<string>();
    for (const eventIndex of run.eventIndices) {
      collectToolUseIds(input.agentEvents[eventIndex], toolCallIds);
    }
    if (toolCallIds.size === 0) continue;
    const subagentIds = subagentIdsForToolCallIds(toolCallIds, input.order, input.descriptors);
    if (subagentIds.length === 0) continue;
    byRunKey.set(run.runKey, buildSubagentActivity({
      order: subagentIds,
      descriptors: input.descriptors,
      events: input.subagentEvents,
    }));
  }

  return byRunKey;
}

/**
 * 两个活动投影是否**渲染等价**。
 *
 * 存在的理由：`CodeMuxThread` 的 render context 里带着这张查找表，context 换身份就会让
 * **每一行已挂载消息**重新协调（该文件里记着实测：24 行→41 次行渲染，120 行→201 次）。
 * 子智能体吐字时每个 delta 都会换掉时间线数组身份，若不比较就等于每来一个字重渲整棵
 * 消息树——这正是主线程被占满、连计时器都停跳的原因。
 *
 * 比较必须**逐字段覆盖**每个参与渲染的值：漏掉一个字段的后果是 UI 静默不更新，比多渲染
 * 几次严重得多。`durationMs` 只在终态节点上有意义（live 节点由展示层按秒自走），
 * `endedAt` 同理，所以运行中子智能体的时长推进不会让这张表被判为「变了」。
 */
export function subagentActivityEqual(a: SubagentActivity, b: SubagentActivity): boolean {
  if (a === b) return true;
  if (a.nodes.length !== b.nodes.length) return false;
  const sa = a.summary;
  const sb = b.summary;
  if (
    sa.total !== sb.total
    || sa.finished !== sb.finished
    || sa.running !== sb.running
    || sa.failed !== sb.failed
    || sa.startedAt !== sb.startedAt
    || sa.endedAt !== sb.endedAt
  ) {
    return false;
  }
  for (let index = 0; index < a.nodes.length; index += 1) {
    if (!subagentActivityNodeEqual(a.nodes[index], b.nodes[index])) return false;
  }
  return true;
}

function subagentActivityNodeEqual(
  a: SubagentActivityNode,
  b: SubagentActivityNode,
): boolean {
  return a.subagentId === b.subagentId
    && a.name === b.name
    && a.provider === b.provider
    && a.model === b.model
    && a.statusLabel === b.statusLabel
    && a.status === b.status
    && a.detail === b.detail
    && a.durationMs === b.durationMs
    && a.startedAt === b.startedAt
    && a.stepCount === b.stepCount
    && a.live === b.live;
}

/**
 * 按 runKey 逐项比较两张活动查找表，供 `CodeMuxThread` 决定能否复用上一张。
 *
 * runKey 集合本身也参与比较：委派从一个处理段「迁移」到另一个（工具卡换位）时，
 * 只有集合完全一致才谈得上复用。
 */
export function runSubagentActivityEqual(
  a: ReadonlyMap<string, SubagentActivity>,
  b: ReadonlyMap<string, SubagentActivity>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [runKey, activity] of a) {
    const other = b.get(runKey);
    if (!other || !subagentActivityEqual(activity, other)) return false;
  }
  return true;
}
