import { isEphemeralLiveStreamNarrationEvent, type AgentMessage } from '../../../stores/agentStore';
import { isCodexCompactSummaryText } from '../../../stores/agentEventParsing';
import type { AgentUserMessageLocator, ContentBlock } from '../../../types/agent';
import type { UserAttachmentPreview } from '../../../types/agentInput';
import { isHiddenAssistantThreadUserEvent } from './assistantResultTargets';
import { buildConversationTurns } from '../../../lib/conversationTurns';
import { isAskUserQuestionToolName } from '../../../lib/askUserQuestionTools';

type CodeMuxAssistantRole = 'user' | 'assistant' | 'system';

type CodeMuxVisibleEventKind = Extract<AgentMessage['kind'], 'api_retry' | 'compact' | 'error' | 'native_session_rebuilt' | 'permission_update_deferred' | 'stream_status' | 'session_summary'>;

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
    sourceOpenCodeSessionId?: string;
    sourceProviderTurnId?: string;
    isFinalAssistantMessage?: boolean;
    isSplitHead?: boolean;
    attachments?: UserAttachmentPreview[];
    locator?: AgentUserMessageLocator;
  };
};

const visibleEventKinds = ['api_retry', 'compact', 'error', 'native_session_rebuilt', 'permission_update_deferred', 'stream_status', 'session_summary'] as const satisfies readonly CodeMuxVisibleEventKind[];

export function convertAgentEventsToAssistantMessages(
  events: AgentMessage[],
  conversationTurns?: ReturnType<typeof buildConversationTurns>,
  /**
   * 切片偏移：`events` 是「尾部挂载窗口」切片（工单 03）时，给出它在完整历史里的
   * 起始事件下标。转换产出的 `sourceEventIndex` / `msg-N` / 去重 id 一律以绝对下标
   * 命名 —— 切片后必须与全量转换逐字节一致，否则 rewind 与跳转全部失灵（正确性红线）。
   */
  eventIndexOffset: number = 0,
): CodeMuxAssistantMessage[] {
  const messages: CodeMuxAssistantMessage[] = [];
  const toolCallLocationById = new Map<string, { messageIndex: number; partIndex: number }>();
  const askQuestionToolUseIds = new Set<string>();
  const pendingToolResultsById = new Map<string, { content: string; isError: boolean }>();
  const pendingSessionSummaries: Array<{
    event: Extract<AgentMessage, { kind: 'session_summary' }>;
    sourceIndex: number;
  }> = [];
  const usedMessageIds = new Set<string>();

  const ensureUniqueId = (id: string, index: number): string => {
    let candidate = id;
    let suffix = 0;
    while (usedMessageIds.has(candidate)) {
      suffix += 1;
      candidate = `${id}-dup${index}-${suffix}`;
    }
    usedMessageIds.add(candidate);
    return candidate;
  };

  events.forEach((event, loopIndex) => {
    // 绝对事件下标（正确性红线）：切片偏移加上切片内的位置 = 全量转换时的下标。
    const index = eventIndexOffset + loopIndex;
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
      if (isEphemeralLiveStreamNarrationEvent(event)) {
        return;
      }

      const seenToolCallIds = new Set<string>();
      const batchToolCallParts = new Map<string, CodeMuxToolCallPart>();
      const parts = event.data.message.content
        .flatMap((block, blockIndex) => convertContentBlockToParts(block, index, blockIndex))
        .filter((part) => {
          if (part.type !== 'tool-call') {
            return true;
          }
          if (isDuplicateAskUserQuestionToolCall(part, toolCallLocationById, askQuestionToolUseIds)) {
            return false;
          }
          const existing = resolveExistingToolCallPart(part.toolCallId, toolCallLocationById, messages, batchToolCallParts);
          if (existing) {
            // A repeated projection of the same tool call refreshes its args in
            // place (OpenCode streams tool input after the first tool_started)
            // instead of rendering a duplicate card.
            existing.args = { ...existing.args, ...part.args };
            return false;
          }
          seenToolCallIds.add(part.toolCallId);
          batchToolCallParts.set(part.toolCallId, part);
          return true;
        });

      if (parts.length > 0) {
        const message = createMessage(
          ensureUniqueId(event.data.uuid || `assistant-${index}`, index),
          'assistant',
          parts,
          event,
          index,
        );
        const messageIndex = messages.length;
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
        // OpenCode 可能在最终助手文本前发布 diff，也可能在文件监听器稳定后再次发布。
        // 在确定本轮最终助手消息前，不把它放进实时工具消息。
        pendingSessionSummaries.push({ event, sourceIndex: index });
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

  attachSessionSummariesToFinalAssistants(messages, events, pendingSessionSummaries, conversationTurns);
  markFinalAssistantMessages(messages, events, conversationTurns);

  return messages;
}

type PendingSessionSummary = {
  event: Extract<AgentMessage, { kind: 'session_summary' }>;
  sourceIndex: number;
};

function attachSessionSummariesToFinalAssistants(
  messages: CodeMuxAssistantMessage[],
  events: AgentMessage[],
  pendingSummaries: PendingSessionSummary[],
  conversationTurns?: ReturnType<typeof buildConversationTurns>,
): void {
  if (pendingSummaries.length === 0) {
    return;
  }

  const turns = conversationTurns ?? buildConversationTurns(events, { isRunning: true });
  const summariesByTurnId = new Map<string, PendingSessionSummary[]>();

  for (const summary of pendingSummaries) {
    const turn = turns.find((candidate) => candidate.eventIndices.includes(summary.sourceIndex));
    if (!turn) {
      continue;
    }

    const turnSummaries = summariesByTurnId.get(turn.id) ?? [];
    turnSummaries.push(summary);
    summariesByTurnId.set(turn.id, turnSummaries);
  }

  for (const turn of turns) {
    const turnSummaries = summariesByTurnId.get(turn.id);
    const finalAssistantEventIndex = turn.footerAnchorEventIndex;
    if (!turnSummaries || finalAssistantEventIndex == null) {
      continue;
    }
    if (turn.status !== 'completed' && turn.status !== 'interrupted' && turn.status !== 'failed') {
      continue;
    }

    const messageIndex = findFinalAssistantMessageIndex(messages, finalAssistantEventIndex);
    if (messageIndex < 0) {
      continue;
    }

    const summary = coalesceSessionSummaries(turnSummaries);
    const message = messages[messageIndex];
    messages[messageIndex] = {
      ...message,
      content: [...message.content, createEventPart('session_summary', summary.event)],
      metadata: {
        ...message.metadata,
        sourceEventIndices: [
          ...message.metadata.sourceEventIndices,
          ...summary.sourceIndices,
        ],
      },
    };
  }
}

function coalesceSessionSummaries(summaries: PendingSessionSummary[]): {
  event: Extract<AgentMessage, { kind: 'session_summary' }>;
  sourceIndices: number[];
} {
  const latestDiffByFile = new Map<string, Extract<AgentMessage, { kind: 'session_summary' }>['data']['diffs'][number]>();
  const lastSummary = summaries[summaries.length - 1];

  for (const summary of summaries) {
    for (const diff of summary.event.data.diffs) {
      latestDiffByFile.set(diff.file, diff);
    }
  }

  return {
    event: {
      ...lastSummary.event,
      data: {
        ...lastSummary.event.data,
        diffs: [...latestDiffByFile.values()],
      },
    },
    sourceIndices: summaries.map((summary) => summary.sourceIndex),
  };
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
  conversationTurns?: ReturnType<typeof buildConversationTurns>,
): void {
  const assistantIndicesWithResult = new Set(
    (conversationTurns ?? buildConversationTurns(events, { isRunning: true }))
      .filter((turn) => turn.hasRealUser || turn.status !== 'interrupted')
      .map((turn) => turn.footerAnchorEventIndex)
      .filter((index): index is number => index != null),
  );

  for (const footerIndex of assistantIndicesWithResult) {
    const messageIndex = findFinalAssistantMessageIndex(messages, footerIndex);
    if (messageIndex < 0) {
      continue;
    }

    messages[messageIndex].metadata.isFinalAssistantMessage = true;
  }
}

function findFinalAssistantMessageIndex(
  messages: CodeMuxAssistantMessage[],
  footerIndex: number,
): number {
  const candidateIndices: number[] = [];
  messages.forEach((message, index) => {
    if (
      message.role === 'assistant'
      && message.metadata.sourceEventIndices.includes(footerIndex)
    ) {
      candidateIndices.push(index);
    }
  });
  if (candidateIndices.length === 0) {
    return -1;
  }

  const textIndices = candidateIndices.filter((index) => (
    messages[index].content.some((part) => part.type === 'text')
  ));
  return textIndices[textIndices.length - 1] ?? candidateIndices[candidateIndices.length - 1] ?? -1;
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

  return message.content.every((part) => (
    part.type === 'tool-call' && !isStandaloneToolCall(part)
  ));
}

function isStandaloneToolCall(part: Extract<CodeMuxAssistantPart, { type: 'tool-call' }>): boolean {
  return isAskUserQuestionToolName(part.toolName);
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
    // OpenCode often finalizes a step with a "\n\n" text part. Keep it out of
    // the thread so it cannot split consecutive thinking/tool process groups.
    return typeof block.text === 'string' && block.text.trim().length > 0
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

/**
 * Resolve the already-rendered part for a tool call id — either committed into
 * a previous message or created earlier within the current batch. Later
 * projections of the same call merge their args into it.
 */
function resolveExistingToolCallPart(
  toolCallId: string,
  toolCallLocationById: Map<string, { messageIndex: number; partIndex: number }>,
  messages: CodeMuxAssistantMessage[],
  batchToolCallParts: Map<string, CodeMuxToolCallPart>,
): CodeMuxToolCallPart | undefined {
  const batchPart = batchToolCallParts.get(toolCallId);
  if (batchPart) {
    return batchPart;
  }
  const location = toolCallLocationById.get(toolCallId);
  if (!location) {
    return undefined;
  }
  const part = messages[location.messageIndex]?.content[location.partIndex];
  return part?.type === 'tool-call' ? part : undefined;
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
  extra?: { isSplitHead?: boolean },
): CodeMuxAssistantMessage {
  return {
    id,
    role,
    content,
    metadata: {
      sourceEventIndex: index,
      sourceEventIndices: [index],
      sourceKind: event.kind,
      ...(extra?.isSplitHead === false ? { isSplitHead: false } : {}),
      ...(event.kind === 'assistant' && event.data.uuid ? { sourceUuid: event.data.uuid } : {}),
      ...(event.kind === 'assistant' && event.data.opencode_session_id
        ? { sourceOpenCodeSessionId: event.data.opencode_session_id }
        : {}),
      ...(event.kind === 'assistant' && event.data.provider_turn_id
        ? { sourceProviderTurnId: event.data.provider_turn_id }
        : {}),
      ...(event.kind === 'user' && event.data.attachments?.length
        ? { attachments: event.data.attachments }
        : {}),
      ...(event.kind === 'user' && event.data.locator
        ? { locator: event.data.locator }
        : {}),
    },
  };
}

/**
 * Clones are cached per source event, keyed on the event object the store
 * holds.
 *
 * `createEventPart` used to deep-clone the whole event on every call, and a
 * call happens for every event on every conversion — and a conversion runs
 * whenever the event array changes, i.e. once per incoming event. That made it
 * O(entire transcript payload) per event: with file-read tool results in the
 * history each conversion deep-cloned megabytes, and the main thread burned
 * ~100ms blocks doing nothing but copying. It is measured jank, and it does not
 * show up in the message-tree <Profiler> because the conversion runs one level
 * above it.
 *
 * The clone itself is still wanted — the assistant-ui pipeline must not be able
 * to mutate the events the store owns — but store events are treated as
 * immutable and keep their object identity across conversions (the store only
 * ever appends and filters), so the same clone can be reused. A WeakMap keeps
 * this from retaining events that have scrolled out of the store.
 *
 * Trade-off: if a consumer did mutate the part's event, that mutation now
 * survives instead of being re-cloned away. Nothing is expected to write to
 * this data; it is a read-only projection of the store event.
 */
const clonedEventCache = new WeakMap<AgentMessage, AgentMessage>();

function cloneEventOnce(event: AgentMessage): AgentMessage {
  const cached = clonedEventCache.get(event);
  if (cached) {
    return cached;
  }

  const cloned = cloneJsonValue(event);
  clonedEventCache.set(event, cloned);
  return cloned;
}

function createEventPart(
  eventKind: AgentMessage['kind'],
  event: AgentMessage,
): Extract<CodeMuxAssistantPart, { type: 'data-codemux-event' }> {
  return {
    type: 'data-codemux-event',
    eventKind,
    event: cloneEventOnce(event),
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

/** Parent Task/Agent tool results — used when subagent timeline lost the final summary. */
export function extractAgentToolResultText(
  events: AgentMessage[],
  toolCallId: string,
): string | undefined {
  for (const event of events) {
    if (event.kind !== 'tool_result') {
      continue;
    }
    for (const result of getToolResults(event)) {
      if (result.toolUseId === toolCallId && result.content.trim().length > 0) {
        return stripAgentToolResultMetadata(result.content);
      }
    }
  }
  return undefined;
}

