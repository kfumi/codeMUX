import type { AgentMessage } from '../../../stores/agentStore';
import type { ContentBlock } from '../../../types/agent';

type CodeMuxAssistantRole = 'user' | 'assistant' | 'system';

type CodeMuxVisibleEventKind = Extract<AgentMessage['kind'], 'ask_user_question'>;

type PersistedContentBlock = ContentBlock | Record<string, unknown> | null | undefined;

type CodeMuxToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

export type CodeMuxAssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | CodeMuxToolCallPart
  | {
      type: 'data-codemux-event';
      eventKind: AgentMessage['kind'];
      event: AgentMessage;
    };

export type CodeMuxAssistantMessage = {
  id: string;
  role: CodeMuxAssistantRole;
  content: CodeMuxAssistantPart[];
  metadata: {
    sourceEventIndex: number;
    sourceKind: AgentMessage['kind'];
  };
};

const visibleEventKinds = ['ask_user_question'] as const satisfies readonly CodeMuxVisibleEventKind[];

export function convertAgentEventsToAssistantMessages(
  events: AgentMessage[],
): CodeMuxAssistantMessage[] {
  const messages: CodeMuxAssistantMessage[] = [];
  const toolCallLocationById = new Map<string, { messageIndex: number; partIndex: number }>();
  const askQuestionLocationByToolUseId = new Map<string, { messageIndex: number; partIndex: number }>();

  events.forEach((event, index) => {
    if (event.kind === 'user') {
      const text = event.data.content.trim();

      if (text.length > 0) {
        messages.push(createMessage(`user-${index}`, 'user', [{ type: 'text', text }], event, index));
      }

      return;
    }

    if (event.kind === 'assistant') {
      const parts = event.data.message.content.flatMap((block, blockIndex) =>
        convertContentBlockToParts(block, index, blockIndex),
      );

      if (parts.length > 0) {
        const messageIndex = messages.length;
        const message = createMessage(
          event.data.uuid || `assistant-${index}`,
          'assistant',
          parts,
          event,
          index,
        );

        messages.push(message);
        message.content.forEach((part, partIndex) => {
          if (part.type === 'tool-call') {
            toolCallLocationById.set(part.toolCallId, { messageIndex, partIndex });
          }
        });
      }

      return;
    }

    if (event.kind === 'tool_result') {
      for (const result of getToolResults(event)) {
        attachToolResult(
          messages,
          toolCallLocationById,
          result.toolUseId,
          result.content,
          result.isError,
        );
        attachAskQuestionResult(
          messages,
          askQuestionLocationByToolUseId,
          result.toolUseId,
          result.content,
        );
      }

      return;
    }

    if (isVisibleEventKind(event.kind)) {
      const messageIndex = messages.length;
      const part = createEventPart(event.kind, event);
      messages.push(
        createMessage(
          `${event.kind}-${index}`,
          'system',
          [part],
          event,
          index,
        ),
      );

      if (event.kind === 'ask_user_question') {
        askQuestionLocationByToolUseId.set(event.data.tool_use_id, { messageIndex, partIndex: 0 });
      }
    }
  });

  return messages;
}

function convertContentBlockToParts(
  block: PersistedContentBlock,
  eventIndex: number,
  blockIndex: number,
): CodeMuxAssistantPart[] {
  if (!isRecord(block)) {
    return [];
  }

  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text.length > 0
      ? [{ type: 'text', text: block.text }]
      : [];
  }

  if (block.type === 'thinking') {
    return typeof block.thinking === 'string' && block.thinking.length > 0
      ? [{ type: 'reasoning', text: block.thinking }]
      : [];
  }

  if (block.type === 'tool_use') {
    const toolName = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
    const toolCallId =
      typeof block.id === 'string' && block.id.length > 0
        ? block.id
        : `${toolName}-${eventIndex}-${blockIndex}`;

    return [
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: cloneRecord(isRecord(block.input) ? block.input : {}),
        result: undefined,
        isError: undefined,
      },
    ];
  }

  return [];
}

function attachToolResult(
  messages: CodeMuxAssistantMessage[],
  toolCallLocationById: Map<string, { messageIndex: number; partIndex: number }>,
  toolCallId: string,
  result: string,
  isError: boolean,
): boolean {
  const location = toolCallLocationById.get(toolCallId);

  if (!location) {
    return false;
  }

  const message = messages[location.messageIndex];
  const part = message?.content[location.partIndex];

  if (!message || part?.type !== 'tool-call') {
    return false;
  }

  const content = [...message.content];
  content[location.partIndex] = { ...part, result, isError };
  messages[location.messageIndex] = { ...message, content };
  return true;
}


function attachAskQuestionResult(
  messages: CodeMuxAssistantMessage[],
  askQuestionLocationByToolUseId: Map<string, { messageIndex: number; partIndex: number }>,
  toolCallId: string,
  result: string,
): boolean {
  const location = askQuestionLocationByToolUseId.get(toolCallId);

  if (!location) {
    return false;
  }

  const message = messages[location.messageIndex];
  const part = message?.content[location.partIndex];

  if (!message || part?.type !== 'data-codemux-event' || part.event.kind !== 'ask_user_question') {
    return false;
  }

  const content = [...message.content];
  content[location.partIndex] = {
    ...part,
    event: {
      ...part.event,
      data: {
        ...(part.event.data as Record<string, unknown>),
        submitted: true,
        resultContent: result,
      } as unknown as Extract<AgentMessage, { kind: 'ask_user_question' }>['data'],
    },
  };
  messages[location.messageIndex] = { ...message, content };
  return true;
}

function getToolResults(
  event: Extract<AgentMessage, { kind: 'tool_result' }>,
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const results: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
  const data = event.data as unknown;

  if (isRecord(data)) {
    const message = data.message;
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const result of message.content) {
        if (!isRecord(result) || result.type !== 'tool_result' || typeof result.tool_use_id !== 'string') {
          continue;
        }

        results.push({
          toolUseId: result.tool_use_id,
          content: stringifyToolResultContent(result.content),
          isError: getBooleanValue(result, 'is_error') || hasExplicitFailureSignal(result.content),
        });
      }
    }

    const toolUseResult = data.tool_use_result;
    if (isRecord(toolUseResult) && typeof toolUseResult.tool_use_id === 'string') {
      const rawResult = toolUseResult.content ?? toolUseResult.result;
      results.push({
        toolUseId: toolUseResult.tool_use_id,
        content: stringifyToolResultContent(rawResult),
        isError: getBooleanValue(toolUseResult, 'is_error') || hasExplicitFailureSignal(rawResult),
      });
    }
  }

  return results;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content == null) {
    return '';
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function getBooleanValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function hasExplicitFailureSignal(value: unknown): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      return hasExplicitFailureSignal(parsed);
    }

    const exitCode = extractExitCode(value);
    return exitCode != null && exitCode !== 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitFailureSignal(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (
    value.is_error === true ||
    value.error === true ||
    value.success === false ||
    value.ok === false ||
    value.status === 'error' ||
    value.status === 'failed' ||
    value.status === 'failure' ||
    value.status === 'cancelled' ||
    value.status === 'canceled'
  ) {
    return true;
  }

  const exitCode = getNumericField(value, ['exit_code', 'exitCode', 'code']);
  if (exitCode != null) {
    return exitCode !== 0;
  }

  return Object.values(value).some((nested) => hasExplicitFailureSignal(nested));
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractExitCode(value: string): number | undefined {
  const match = value.match(/\bexit code\s+(-?\d+)\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNumericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function createMessage(
  id: string,
  role: CodeMuxAssistantRole,
  content: CodeMuxAssistantPart[],
  event: AgentMessage,
  index: number,
): CodeMuxAssistantMessage {
  return {
    id,
    role,
    content,
    metadata: {
      sourceEventIndex: index,
      sourceKind: event.kind,
    },
  };
}

function createEventPart(
  eventKind: AgentMessage['kind'],
  event: AgentMessage,
): Extract<CodeMuxAssistantPart, { type: 'data-codemux-event' }> {
  return {
    type: 'data-codemux-event',
    eventKind,
    event: cloneJsonValue(event),
  };
}

function isVisibleEventKind(eventKind: AgentMessage['kind']): eventKind is CodeMuxVisibleEventKind {
  return (visibleEventKinds as readonly AgentMessage['kind'][]).includes(eventKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value);
}

function cloneJsonValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

