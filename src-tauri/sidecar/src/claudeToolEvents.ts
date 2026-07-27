import type { TurnSourceEvent } from './turnEventNormalizer.js';

export type ClaudeToolEventProjection = {
  toolEvents: TurnSourceEvent[];
  remainingEvent?: Record<string, unknown>;
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
  }

  return {
    toolEvents,
    remainingEvent: buildRemainingEvent(event, message, remainingContent),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
