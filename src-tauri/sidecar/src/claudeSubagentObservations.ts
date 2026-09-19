import type { SubagentStatus } from './codeMuxProtocol.js';
import type { TurnSourceEvent } from './turnEventNormalizer.js';
import { projectClaudeToolEvents, toClaudeAssistantMessageEvent } from './claudeToolEvents.js';
import { isClaudeSidechainMessage, isClaudeTaskNotification } from './claudeSdkMessageFilter.js';

/**
 * One unit of meaning extracted from a Claude SDK message by the task
 * protocol adapter. Observations are pure data; folding them into domain
 * events (and keeping descriptor state) lives in claudeSubagentFold.ts.
 */
export type SubagentObservation =
  | {
      kind: 'declared';
      taskId: string;
      toolUseIds: string[];
      title?: string;
      description?: string;
      /** Secondary line (e.g. the codex agent path); never the task text. */
      subtitle?: string;
      /** First timeline entry content (workflow uses description). */
      prompt?: string;
      isWorkflow: boolean;
      /** Defaults to 'claude'; OpenCode declarations set 'opencode'. */
      provider?: string;
      /**
       * Model the declaration names for this child (codex spawn calls carry it).
       * It never reaches the upsert: the fold stamps it onto the timeline events
       * so the subagent preview can label the child with it.
       */
      model?: string;
    }
  | { kind: 'status'; taskId: string; status: SubagentStatus }
  | { kind: 'subtitle'; taskId: string; subtitle: string }
  | { kind: 'backgrounded'; taskId: string; isBackgrounded: boolean }
  | {
      kind: 'timeline';
      /** Parent-side tool_use_id naming the subagent; unresolved ids are dropped by the fold. */
      parentToolUseId?: string;
      /** Sidechain frame uuid of the parent user/tool_result message (final summaries). */
      parentUuid?: string;
      /** This sidechain frame's uuid — registered for later parentUuid lookups. */
      sidechainMessageUuid?: string;
      events: TurnSourceEvent[];
    };

/** Claude task types that never represent an Agent/Task/Workflow subagent. */
const IGNORED_TASK_TYPES = new Set(['local_bash']);

const TRACKED_TASK_TYPES = new Set(['local_agent', 'local_workflow']);

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'subagent', 'task']);

export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractTaskId(message: Record<string, unknown>): string | undefined {
  return asString(message.task_id)
    ?? (() => {
      const origin = asRecord(message.origin);
      return origin ? asString(origin.task_id) : undefined;
    })();
}

/** Map a Claude task status onto the CodeMUX lifecycle status. */
export function mapClaudeTaskStatus(value: unknown): SubagentStatus | undefined {
  switch (value) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'canceled';
    default:
      return undefined;
  }
}

function extractToolUseIds(message: Record<string, unknown>): string[] {
  if (typeof message.tool_use_id === 'string' && message.tool_use_id.length > 0) {
    return [message.tool_use_id];
  }
  if (Array.isArray(message.tool_use_id)) {
    return message.tool_use_id.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (Array.isArray(message.tool_use_ids)) {
    return message.tool_use_ids.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  return [];
}

function formatUsageSubtitle(usage: unknown): string | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  const input = typeof record.input_tokens === 'number' ? record.input_tokens : 0;
  const output = typeof record.output_tokens === 'number' ? record.output_tokens : 0;
  if (input <= 0 && output <= 0) return undefined;
  return `tokens ↑${formatTokenCount(input)} ↓${formatTokenCount(output)}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function observeTaskStarted(message: Record<string, unknown>): SubagentObservation[] {
  const taskId = extractTaskId(message);
  if (!taskId) return [];
  if (message.skip_transcript === true) return [];

  const taskType = asString(message.task_type);
  if (taskType && IGNORED_TASK_TYPES.has(taskType)) return [];
  if (taskType && !TRACKED_TASK_TYPES.has(taskType)) return [];

  const subagentType = asString(message.subagent_type) ?? asString(message.agent_type);
  // Without an explicit task_type, only messages that name a subagent type
  // are Agent/Task announcements; anything else is not a trackable child.
  if (!taskType && !subagentType) return [];

  const toolUseIds = extractToolUseIds(message);
  if (toolUseIds.length === 0) return [];

  const isWorkflow = taskType === 'local_workflow';
  const description = asString(message.description);
  const prompt = isWorkflow ? description : asString(message.prompt) ?? description;
  const title = subagentType ?? asString(message.name);

  return [{
    kind: 'declared',
    taskId,
    toolUseIds,
    ...(title ? { title } : {}),
    ...(description ?? prompt ? { description: description ?? prompt } : {}),
    ...(prompt ? { prompt } : {}),
    isWorkflow,
  }];
}

function observeTaskUpdated(message: Record<string, unknown>): SubagentObservation[] {
  const taskId = extractTaskId(message);
  if (!taskId) return [];
  const observations: SubagentObservation[] = [];

  const patch = asRecord(message.patch) ?? message;
  if (typeof patch.is_backgrounded === 'boolean') {
    observations.push({ kind: 'backgrounded', taskId, isBackgrounded: patch.is_backgrounded });
  }
  const status = mapClaudeTaskStatus(patch.status);
  if (status) {
    observations.push({ kind: 'status', taskId, status });
  }
  return observations;
}

function observeTaskNotification(message: Record<string, unknown>): SubagentObservation[] {
  const taskId = extractTaskId(message);
  if (!taskId) return [];
  const observations: SubagentObservation[] = [];

  const status = mapClaudeTaskStatus(message.status ?? message.task_status);
  if (status) {
    observations.push({ kind: 'status', taskId, status });
  }
  const subtitle = asString(message.subtitle) ?? formatUsageSubtitle(message.usage);
  if (subtitle) {
    observations.push({ kind: 'subtitle', taskId, subtitle });
  }
  return observations;
}

function observeTaskProgress(message: Record<string, unknown>): SubagentObservation[] {
  const taskId = extractTaskId(message);
  if (!taskId) return [];
  const subtitle = asString(message.subtitle)
    ?? asString(message.description)
    ?? formatUsageSubtitle(message.usage);
  return subtitle ? [{ kind: 'subtitle', taskId, subtitle }] : [];
}

/** Project a sidechain SDK frame into parent-normalizer-shaped source events. */
export function projectSidechainTurnSourceEvents(message: Record<string, unknown>): TurnSourceEvent[] {
  const projection = projectClaudeToolEvents(message);
  const events: TurnSourceEvent[] = [...projection.toolEvents];
  if (projection.remainingEvent) {
    const remaining = toClaudeAssistantMessageEvent(projection.remainingEvent);
    if (remaining) events.push(remaining);
  }
  return events;
}

/** Project a sidechain frame, recording a projection failure as an error event instead of throwing. */
function projectSidechainSafely(message: Record<string, unknown>): TurnSourceEvent[] {
  try {
    return projectSidechainTurnSourceEvents(message);
  } catch (error) {
    return [{
      kind: 'error',
      subtype: 'subagent_projection_failed',
      message: `Failed to project sidechain frame: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

/**
 * Pure Claude adapter seam: SDK message in, observations out. Returns an
 * empty array for messages the adapter does not describe. The caller is
 * responsible for still dropping these raw frames from the parent timeline.
 */
export function observeClaudeSdkMessage(message: Record<string, unknown>): SubagentObservation[] {
  if (isClaudeSidechainMessage(message)) {
    const parentToolUseId = asString(message.parent_tool_use_id);
    const parentUuid = asString(message.parentUuid) ?? asString(message.parent_uuid);
    const sidechainMessageUuid = asString(message.uuid);
    const events = projectSidechainSafely(message);
    if (events.length === 0) return [];
    return [{
      kind: 'timeline',
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(parentUuid ? { parentUuid } : {}),
      ...(sidechainMessageUuid ? { sidechainMessageUuid } : {}),
      events,
    }];
  }
  if (isClaudeTaskNotification(message)) {
    return observeTaskNotification(message);
  }
  if (message.type !== 'system' || typeof message.subtype !== 'string') {
    return [];
  }
  switch (message.subtype) {
    case 'task_started':
      return observeTaskStarted(message);
    case 'task_updated':
      return observeTaskUpdated(message);
    case 'task_progress':
      return observeTaskProgress(message);
    case 'task_notification':
      return observeTaskNotification(message);
    default:
      return [];
  }
}

/**
 * 侧链流式文本的拼装器。
 *
 * 线上实测（会话 8ba20d2b 的两个 Claude 子智能体）：SDK 给我们的子会话**聚合帧只带
 * `tool_use`**（DB 里 tool_started 条数 38 / 23，与原生子会话记录里 tool_use 帧数一模一样），
 * 子会话的思考与正文**只以 `stream_event` 增量**形态到达。而子智能体时间线只渲染
 * `assistant_message`（面板的转换器不渲染 `text_delta` 这类流式事件），这些增量此前被整批
 * 丢弃 —— 表现为「子智能体面板只有工具行、没有正文」，模型名也随之下不来。
 *
 * 这里按 content block 累积增量，块结束时合成一条 `assistant_message` 交回 fold：与
 * OpenCode 子智能体在 part 完成时产出聚合消息的做法同形。
 */
export class ClaudeSidechainStreamAssembler {
  /** key = `${parentToolUseId}#${index}`：该内容块累积的文本与类型。 */
  private readonly buffers = new Map<string, { kind: 'text' | 'reasoning'; text: string }>();

  consume(message: Record<string, unknown>): SubagentObservation[] {
    if (message.type !== 'stream_event' || !isClaudeSidechainMessage(message)) return [];
    const parentToolUseId = asString(message.parent_tool_use_id);
    // 没有父工具 id 就无法定位是哪个子智能体：与既有 timeline 观察同一套路由前提，
    // 拿不到就丢弃（不猜、不塞进父线程）。
    if (!parentToolUseId) return [];
    const inner = asRecord(message.event);
    if (!inner || typeof inner.type !== 'string') return [];
    const index = typeof inner.index === 'number' ? inner.index : 0;
    const key = `${parentToolUseId}#${index}`;

    if (inner.type === 'content_block_start') {
      const block = asRecord(inner.content_block);
      this.buffers.set(key, { kind: block?.type === 'thinking' ? 'reasoning' : 'text', text: '' });
      return [];
    }
    if (inner.type === 'content_block_delta') {
      const delta = asRecord(inner.delta);
      const buffer = this.buffers.get(key) ?? { kind: 'text' as const, text: '' };
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') buffer.text += delta.text;
      else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') buffer.text += delta.thinking;
      this.buffers.set(key, buffer);
      return [];
    }
    if (inner.type === 'content_block_stop') return this.flush(key, parentToolUseId);
    // 一条消息结束：把该子智能体还没闭合的块一起收掉（同一条流里可能有多个块）。
    if (inner.type === 'message_stop') return this.flushSubagent(parentToolUseId);
    return [];
  }

  reset(): void {
    this.buffers.clear();
  }

  private flush(key: string, parentToolUseId: string): SubagentObservation[] {
    const buffer = this.buffers.get(key);
    this.buffers.delete(key);
    if (!buffer) return [];
    return materialize(parentToolUseId, buffer);
  }

  private flushSubagent(parentToolUseId: string): SubagentObservation[] {
    const observations: SubagentObservation[] = [];
    for (const key of [...this.buffers.keys()]) {
      if (!key.startsWith(`${parentToolUseId}#`)) continue;
      observations.push(...this.flush(key, parentToolUseId));
    }
    return observations;
  }
}

/** 空白块（只有空格/换行）不合成消息，避免面板出现空行。 */
function materialize(
  parentToolUseId: string,
  buffer: { kind: 'text' | 'reasoning'; text: string },
): SubagentObservation[] {
  if (buffer.text.trim().length === 0) return [];
  const block = buffer.kind === 'reasoning'
    ? { type: 'thinking', thinking: buffer.text }
    : { type: 'text', text: buffer.text };
  return [{
    kind: 'timeline',
    parentToolUseId,
    events: [{ kind: 'assistant_message', content: [block] }],
  }];
}
