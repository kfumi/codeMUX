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
   * 事件里带出来的模型名（sidecar 侧正在补 `model` 字段）。取不到就是 `undefined`，
   * 展示层退回 `provider`（`claude` / `opencode`），不留空、不崩。
   */
  model?: string;
  /** 运行中 / 已完成 / 失败 / 已取消。 */
  statusLabel: string;
  status: SubagentStatus;
  /** 描述（`description`，退回 `subtitle`）。 */
  detail: string;
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
  /** 运行中节点的时长截止点。默认当前时间；测试传固定值。 */
  now?: number;
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
 * （调用方退回显示 `provider`）。字段是另一路改动正在补的，这里不能因为缺失而留空或抛错。
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
 * 时间线数组由 store 在每次追加时整体替换，所以按数组身份缓存即可：没变化的子智能体
 * 不必在每来一个事件时重算整条时间线。
 */
const stepCountCache = new WeakMap<readonly Record<string, unknown>[], number>();

function timelineStepCount(timeline: readonly Record<string, unknown>[]): number {
  if (timeline.length === 0) return 0;
  const cached = stepCountCache.get(timeline);
  if (cached !== undefined) return cached;
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
  stepCountCache.set(timeline, stepCount);
  return stepCount;
}

export function buildSubagentActivity({
  order,
  descriptors,
  events,
  now,
}: SubagentActivityInput): SubagentActivity {
  const clock = now ?? Date.now();
  const nodes: SubagentActivityNode[] = [];
  let startedAt: number | undefined;
  let endedAt: number | undefined;

  for (const subagentId of order) {
    const descriptor = descriptors[subagentId];
    if (!descriptor) continue;
    const timeline = events[subagentId] ?? [];
    const live = descriptor.status === 'running';
    const { startedAt: first, endedAt: last } = timelineBounds(timeline);
    // 运行中的时长以「现在」为截止点，结束的用末条事件时间戳。
    const end = live ? clock : (last ?? first);
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
      stepCount: timelineStepCount(timeline),
      live,
    });

    if (first !== undefined) {
      startedAt = startedAt === undefined ? first : Math.min(startedAt, first);
    }
    if (last !== undefined) {
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
  now?: number;
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
      ...(input.now !== undefined ? { now: input.now } : {}),
    }));
  }

  return byRunKey;
}
