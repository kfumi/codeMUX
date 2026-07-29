import type { AgentMessage } from '../../../stores/agentStore';
import { isCodexCompactSummaryText } from '../../../stores/agentEventParsing';
import type { AgentUserMessageLocator, ContentBlock } from '../../../types/agent';
import type { UserAttachmentPreview } from '../../../types/agentInput';
import { isHiddenAssistantThreadUserEvent } from './assistantResultTargets';
import { buildConversationTurns } from '../../../lib/conversationTurns';

type CodeMuxAssistantRole = 'user' | 'assistant' | 'system';

type CodeMuxVisibleEventKind = Extract<AgentMessage['kind'], 'api_retry' | 'compact' | 'error' | 'stream_status' | 'session_summary'>;

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
    sourceEventIndices: number[];
    sourceKind: AgentMessage['kind'];
    sourceUuid?: string;
    isFinalAssistantMessage?: boolean;
    attachments?: UserAttachmentPreview[];
    locator?: AgentUserMessageLocator;
  };
};

const visibleEventKinds = ['api_retry', 'compact', 'error', 'stream_status', 'session_summary'] as const satisfies readonly CodeMuxVisibleEventKind[];

export function convertAgentEventsToAssistantMessages(
  events: AgentMessage[],
): CodeMuxAssistantMessage[] {
  const messages: CodeMuxAssistantMessage[] = [];
  const toolCallLocationById = new Map<string, { messageIndex: number; partIndex: number }>();
  const askQuestionToolUseIds = new Set<string>();
  const pendingToolResultsById = new Map<string, { content: string; isError: boolean }>();
  const usedMessageIds = new Set<string>();

  const ensureUniqueId = (id: string, index: number): string => {
    if (usedMessageIds.has(id)) {
      return `${id}-dup${index}`;
    }
    usedMessageIds.add(id);
    return id;
  };

  const attachSessionSummaryToLastAssistant = (summaryEvent: AgentMessage, sourceIndex: number) => {
    const lastAssistantIndex = messages.reduce<number | undefined>(
      (acc, message, index) => (message.role === 'assistant' ? index : acc),
      undefined,
    );
    if (lastAssistantIndex != null) {
      const message = messages[lastAssistantIndex];
      messages[lastAssistantIndex] = {
        ...message,
        content: [...message.content, createEventPart('session_summary', summaryEvent)],
        metadata: {
          ...message.metadata,
          sourceEventIndices: [...message.metadata.sourceEventIndices, sourceIndex],
        },
      };
      return true;
    }
    return false;
  };

  events.forEach((event, index) => {
    if (event.kind === 'user') {
      const text = event.data.content.trim();
      const hasAttachments = (event.data.attachments?.length ?? 0) > 0;

      if (isHiddenAssistantThreadUserEvent(event)) {
        return;
      }

      if (text.length > 0 || hasAttachments) {
        messages.push(createMessage(ensureUniqueId(`user-${index}`, index), 'user', [{ type: 'text', text }], event, index));
      }

      return;
    }

    if (event.kind === 'assistant') {
      if (isCodexCompactSummaryAssistantEvent(event)) {
        return;
      }

      const parts = event.data.message.content
        .flatMap((block, blockIndex) => convertContentBlockToParts(block, index, blockIndex))
        .filter((part) => !isDuplicateAskUserQuestionToolCall(part, toolCallLocationById, askQuestionToolUseIds));

      if (parts.length > 0) {
        const message = createMessage(
          ensureUniqueId(event.data.uuid || `assistant-${index}`, index),
          'assistant',
          parts,
          event,
          index,
        );
        const messageIndex = getAssistantInsertionIndex(messages, message) ?? messages.length;
        const mergedMessageIndex = mergeIntoPreviousToolOnlyMessage(
          messages,
          message,
          messageIndex,
          toolCallLocationById,
        );

        if (mergedMessageIndex != null) {
          message.content.forEach((part, partIndex) => {
            if (part.type === 'tool-call') {
              const mergedPartIndex = messages[mergedMessageIndex]?.content.length - message.content.length + partIndex;
              toolCallLocationById.set(part.toolCallId, {
                messageIndex: mergedMessageIndex,
                partIndex: mergedPartIndex,
              });
              const pendingResult = pendingToolResultsById.get(part.toolCallId);
              if (pendingResult) {
                attachToolResult(
                  messages,
                  toolCallLocationById,
                  part.toolCallId,
                  pendingResult.content,
                  pendingResult.isError,
                );
                pendingToolResultsById.delete(part.toolCallId);
              }
            }
          });

          return;
        }

        if (messageIndex < messages.length) {
          messages.splice(messageIndex, 0, message);
          shiftLocationIndexes(toolCallLocationById, messageIndex);
        } else {
          messages.push(message);
        }

        message.content.forEach((part, partIndex) => {
          if (part.type === 'tool-call') {
            toolCallLocationById.set(part.toolCallId, { messageIndex, partIndex });
            const pendingResult = pendingToolResultsById.get(part.toolCallId);
            if (pendingResult) {
              attachToolResult(
                messages,
                toolCallLocationById,
                part.toolCallId,
                pendingResult.content,
                pendingResult.isError,
              );
              pendingToolResultsById.delete(part.toolCallId);
            }
          }
        });
      }

      return;
    }

    if (event.kind === 'tool_result') {
      for (const result of getToolResults(event)) {
        if (askQuestionToolUseIds.has(result.toolUseId)) {
          const attachedToolResult = attachToolResult(
            messages,
            toolCallLocationById,
            result.toolUseId,
            result.content,
            result.isError,
          );
          if (!attachedToolResult) {
            pendingToolResultsById.set(result.toolUseId, {
              content: result.content,
              isError: result.isError,
            });
          }
          continue;
        }

        const attachedToolResult = attachToolResult(
          messages,
          toolCallLocationById,
          result.toolUseId,
          result.content,
          result.isError,
        );
        if (!attachedToolResult) {
          pendingToolResultsById.set(result.toolUseId, {
            content: result.content,
            isError: result.isError,
          });
        }
      }

      return;
    }

    if (event.kind === 'error') {
      const text = typeof event.data.error === 'string' ? event.data.error.trim() : '';
      if (text.length > 0 && !attachLatestPendingToolError(messages, toolCallLocationById, text)) {
        // Fall through to isVisibleEventKind below to render as data-codemux-event
      } else {
        return;
      }
    }

    if (event.kind === 'result') {
      if (event.data.is_error) {
        const text = typeof event.data.result === 'string' ? event.data.result.trim() : '';
        if (text.length > 0) {
          attachLatestPendingToolError(messages, toolCallLocationById, text);
        }
      }
      return;
    }

    if (event.kind === 'ask_user_question') {
      askQuestionToolUseIds.add(event.data.tool_use_id);

      if (!toolCallLocationById.has(event.data.tool_use_id)) {
        const part = createAskUserQuestionToolCallPart(event);
        const message = createMessage(
          ensureUniqueId(`${event.kind}-${index}`, index),
          'assistant',
          [part],
          event,
          index,
        );

        messages.push(message);
        toolCallLocationById.set(event.data.tool_use_id, {
          messageIndex: messages.length - 1,
          partIndex: 0,
        });
      }

      const pendingResult = pendingToolResultsById.get(event.data.tool_use_id);
      if (pendingResult) {
        attachToolResult(
          messages,
          toolCallLocationById,
          event.data.tool_use_id,
          pendingResult.content,
          pendingResult.isError,
        );
        pendingToolResultsById.delete(event.data.tool_use_id);
      }

      return;
    }

    if (event.kind === 'ask_user_question_timeout') {
      const message = event.data.message || '等待用户回复超时，请重新发送消息继续';
      const attachedToolResult = attachToolResult(
        messages,
        toolCallLocationById,
        event.data.tool_use_id,
        message,
        true,
      );

      if (!attachedToolResult) {
        pendingToolResultsById.set(event.data.tool_use_id, {
          content: message,
          isError: true,
        });
      }

      return;
    }

    if (isVisibleEventKind(event.kind)) {
      if (event.kind === 'session_summary') {
        // Attach the summary as a footer on the assistant message that
        // immediately precedes it, rather than rendering standalone.
        const attached = attachSessionSummaryToLastAssistant(event, index);
        if (!attached) {
          // Fallback: render as a standalone system message if no assistant exists.
          messages.push(
            createMessage(
              ensureUniqueId(`session_summary-${index}`, index),
              'system',
              [createEventPart('session_summary', event)],
              event,
              index,
            ),
          );
        }
        return;
      }

      if (event.kind === 'api_retry' && updatePreviousApiRetryMessage(messages, event, index)) {
        return;
      }

      const part = createEventPart(event.kind, event);
      messages.push(
        createMessage(
          ensureUniqueId(`${event.kind}-${index}`, index),
          'system',
          [part],
          event,
          index,
        ),
      );

    }
  });

  markFinalAssistantMessages(messages, events);

  return messages;
}

function updatePreviousApiRetryMessage(
  messages: CodeMuxAssistantMessage[],
  event: Extract<AgentMessage, { kind: 'api_retry' }>,
  index: number,
): boolean {
  const previous = messages[messages.length - 1];
  if (!previous || previous.metadata.sourceKind !== 'api_retry') {
    return false;
  }

  previous.id = `api_retry-${index}`;
  previous.content = [createEventPart('api_retry', event)];
  previous.metadata.sourceEventIndex = index;
  previous.metadata.sourceEventIndices = [...previous.metadata.sourceEventIndices, index];
  return true;
}

function isCodexCompactSummaryAssistantEvent(
  event: Extract<AgentMessage, { kind: 'assistant' }>,
): boolean {
  return event.data.message.content.some((block) => (
    isRecord(block)
    && block.type === 'text'
    && typeof block.text === 'string'
    && isCodexCompactSummaryText(block.text)
  ));
}

function markFinalAssistantMessages(
  messages: CodeMuxAssistantMessage[],
  events: AgentMessage[],
): void {
  const assistantIndicesWithResult = new Set(
    buildConversationTurns(events, { isRunning: true })
      .filter((turn) => turn.hasRealUser || turn.status !== 'interrupted')
      .map((turn) => turn.footerAnchorEventIndex)
      .filter((index): index is number => index != null),
  );

  // Mark the message whose sourceEventIndex is in that set.
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.metadata.sourceEventIndices.some((sourceEventIndex) =>
        assistantIndicesWithResult.has(sourceEventIndex),
      )
    ) {
      message.metadata.isFinalAssistantMessage = true;
    }
  }
}

function mergeIntoPreviousToolOnlyMessage(
  messages: CodeMuxAssistantMessage[],
  nextMessage: CodeMuxAssistantMessage,
  insertionIndex: number,
  toolCallLocationById: Map<string, { messageIndex: number; partIndex: number }>,
): number | undefined {
  const previousIndex = insertionIndex - 1;
  const previousMessage = messages[previousIndex];

  if (
    !previousMessage ||
    !isToolOnlyAssistantMessage(previousMessage) ||
    !isToolOnlyAssistantMessage(nextMessage)
  ) {
    return undefined;
  }

  messages[previousIndex] = {
    ...previousMessage,
    content: [...previousMessage.content, ...nextMessage.content],
    metadata: {
      ...previousMessage.metadata,
      sourceEventIndices: [
        ...previousMessage.metadata.sourceEventIndices,
        ...nextMessage.metadata.sourceEventIndices,
      ],
    },
  };

  for (const [, location] of toolCallLocationById) {
    if (location.messageIndex === insertionIndex) {
      location.messageIndex = previousIndex;
    }
  }

  return previousIndex;
}

function isToolOnlyAssistantMessage(message: CodeMuxAssistantMessage): boolean {
  if (message.role !== 'assistant' || message.content.length === 0) {
    return false;
  }

  return message.content.every((part) => part.type === 'tool-call');
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

function createAskUserQuestionToolCallPart(
  event: Extract<AgentMessage, { kind: 'ask_user_question' }>,
): CodeMuxToolCallPart {
  return {
    type: 'tool-call',
    toolCallId: event.data.tool_use_id,
    toolName: 'AskUserQuestion',
    args: { questions: cloneJsonValue(event.data.questions) },
    result: undefined,
    isError: undefined,
  };
}

function isDuplicateAskUserQuestionToolCall(
  part: CodeMuxAssistantPart,
  toolCallLocationById: Map<string, { messageIndex: number; partIndex: number }>,
  askQuestionToolUseIds: Set<string>,
): boolean {
  return (
    part.type === 'tool-call' &&
    isAskUserQuestionToolName(part.toolName) &&
    askQuestionToolUseIds.has(part.toolCallId) &&
    toolCallLocationById.has(part.toolCallId)
  );
}

function isAskUserQuestionToolName(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'askUserQuestion' || toolName === 'request_user_input' || toolName === 'question';
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
  content[location.partIndex] = {
    ...part,
    result: isAgentToolName(part.toolName) ? stripAgentToolResultMetadata(result) : result,
    isError,
  };
  messages[location.messageIndex] = { ...message, content };
  return true;
}

function isAgentToolName(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'subagent';
}

function stripAgentToolResultMetadata(result: string): string {
  return result
    .replace(/\n?agentId:\s*[a-zA-Z0-9_-]+[^\n]*(?:\n|$)/g, '\n')
    .replace(/\n?<usage>[\s\S]*?<\/usage>/g, '')
    .trim();
}

function attachLatestPendingToolError(
  messages: CodeMuxAssistantMessage[],
  toolCallLocationById: Map<string, { messageIndex: number; partIndex: number }>,
  errorText: string,
): boolean {
  if (errorText.length === 0) {
    return false;
  }

  const pendingEntries = Array.from(toolCallLocationById.entries()).reverse();

  for (const [toolCallId, location] of pendingEntries) {
    const message = messages[location.messageIndex];
    const part = message?.content[location.partIndex];

    if (!message || part?.type !== 'tool-call' || part.result !== undefined) {
      continue;
    }

    return attachToolResult(messages, toolCallLocationById, toolCallId, errorText, true);
  }

  return false;
}

function getAssistantInsertionIndex(
  messages: CodeMuxAssistantMessage[],
  nextMessage: CodeMuxAssistantMessage,
): number | undefined {
  if (!isNarrationOnlyAssistantMessage(nextMessage)) {
    return undefined;
  }

  let insertAt: number | undefined;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      break;
    }

    if (!isPendingToolOnlyAssistantMessage(message)) {
      break;
    }

    insertAt = index;
  }

  return insertAt;
}

function isNarrationOnlyAssistantMessage(message: CodeMuxAssistantMessage): boolean {
  if (message.role !== 'assistant' || message.content.length === 0) {
    return false;
  }

  return message.content.every((part) => part.type === 'text' || part.type === 'reasoning');
}

function isPendingToolOnlyAssistantMessage(message: CodeMuxAssistantMessage): boolean {
  if (message.role !== 'assistant' || message.content.length === 0) {
    return false;
  }

  return message.content.every((part) => part.type === 'tool-call' && part.result === undefined);
}

function shiftLocationIndexes(
  locations: Map<string, { messageIndex: number; partIndex: number }>,
  insertedAt: number,
): void {
  for (const [, location] of locations) {
    if (location.messageIndex >= insertedAt) {
      location.messageIndex += 1;
    }
  }
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

  // Handle array of text blocks (Claude Code format for Agent tool results)
  if (Array.isArray(content)) {
    const textParts = content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string);
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
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
      sourceEventIndices: [index],
      sourceKind: event.kind,
      ...(event.kind === 'assistant' && event.data.uuid ? { sourceUuid: event.data.uuid } : {}),
      ...(event.kind === 'user' && event.data.attachments?.length
        ? { attachments: event.data.attachments }
        : {}),
      ...(event.kind === 'user' && event.data.locator
        ? { locator: event.data.locator }
        : {}),
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

