import type { TurnSourceEvent } from './turnEventNormalizer.js';

export type ClaudeToolEventProjection = {
  toolEvents: TurnSourceEvent[];
  remainingEvent?: Record<string, unknown>;
  planModeChange?: 'on';
};

export function projectClaudeToolEvents(event: Record<string, unknown>): ClaudeToolEventProjection {
  if (event.type !== 'assistant' && event.type !== 'user') {
    return { toolEvents: [], remainingEvent: event };
  }

  const message = asRecord(event.message);
  const content = message?.content;
  if (!message || !Array.isArray(content)) {
    return { toolEvents: [], remainingEvent: event };
  }

  if (event.type === 'assistant') {
    return projectAssistantToolEvents(event, message, content);
  }
  return projectUserToolEvents(event, message, content);
}

function projectAssistantToolEvents(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  content: unknown[],
): ClaudeToolEventProjection {
  const toolEvents: TurnSourceEvent[] = [];
  const remainingContent: unknown[] = [];
  let planModeChange: 'on' | undefined;

  for (const block of content) {
    const value = asRecord(block);
    if (value?.type !== 'tool_use' || typeof value.id !== 'string' || typeof value.name !== 'string') {
      remainingContent.push(block);
      continue;
    }

    toolEvents.push({
      kind: 'tool_started',
      toolUseId: value.id,
      name: value.name,
      input: asRecord(value.input) ?? {},
    });
    if (value.name === 'EnterPlanMode') {
      planModeChange = 'on';
    }
  }

  return {
    toolEvents,
    remainingEvent: buildRemainingEvent(event, message, remainingContent),
    ...(planModeChange ? { planModeChange } : {}),
  };
}

function projectUserToolEvents(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  content: unknown[],
): ClaudeToolEventProjection {
  const toolEvents: TurnSourceEvent[] = [];
  const remainingContent: unknown[] = [];

  for (const block of content) {
    const value = asRecord(block);
    if (value?.type !== 'tool_result' || typeof value.tool_use_id !== 'string') {
      remainingContent.push(block);
      continue;
    }

    toolEvents.push({
      kind: 'tool_finished',
      toolUseId: value.tool_use_id,
      content: stringifyToolResult(value.content),
      isError: value.is_error === true,
    });
  }

  return {
    toolEvents,
    remainingEvent: buildRemainingEvent(event, message, remainingContent),
  };
}

function buildRemainingEvent(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  content: unknown[],
): Record<string, unknown> | undefined {
  return content.length > 0
    ? { ...event, message: { ...message, content } }
    : undefined;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Project a remaining Claude assistant message into a TurnSourceEvent. Used by
 * the parent consume loop and by the subagent sidechain projection.
 */
export function toClaudeAssistantMessageEvent(event: Record<string, unknown>): TurnSourceEvent | undefined {
  if (event.type !== 'assistant') return undefined;
  const message = event.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const stopReason = (message as Record<string, unknown>).stop_reason;
  const model = (message as Record<string, unknown>).model;
  const providerMessageId = typeof event.uuid === 'string' && event.uuid.length > 0
    ? event.uuid
    : undefined;
  const supersedesProviderMessageIds = Array.isArray(event.supersedes)
    ? event.supersedes.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
  return {
    kind: 'assistant_message',
    content: content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && !Array.isArray(block)),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(typeof stopReason === 'string' || stopReason === null ? { stopReason } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(supersedesProviderMessageIds?.length ? { supersedesProviderMessageIds } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
