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
      /** First timeline entry content (workflow uses description). */
      prompt?: string;
      isWorkflow: boolean;
      /** Defaults to 'claude'; OpenCode declarations set 'opencode'. */
      provider?: string;
    }
  | { kind: 'status'; taskId: string; status: SubagentStatus }
  | { kind: 'subtitle'; taskId: string; subtitle: string }
  | { kind: 'backgrounded'; taskId: string; isBackgrounded: boolean }
  | {
      kind: 'timeline';
      /** Parent-side tool_use_id naming the subagent; unresolved ids are dropped by the fold. */
      parentToolUseId?: string;
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
    const events = projectSidechainSafely(message);
    if (events.length === 0) return [];
    return [{ kind: 'timeline', ...(parentToolUseId ? { parentToolUseId } : {}), events }];
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
