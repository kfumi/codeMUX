import { createId } from './utils';
import { isPlanApprovalPermission } from '@shared/lib/agentPermissions';
import {
  extractUserMessageParts,
  isAgentInjectedUserMessage,
  isCompactSummaryText,
  isHiddenTranscriptUserMessage,
  isSwitchBriefingOnlyMessage,
  type UserAttachmentPreview,
} from './userMessageDisplay';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface SessionSummaryDiff {
  file: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  before?: string;
  after?: string;
}

export type ChatMessage =
  | {
      kind: 'user';
      id: string;
      content: string;
      attachments?: UserAttachmentPreview[];
      timestamp?: number;
      sourceUuid?: string;
    }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      streaming?: boolean;
      timestamp?: number;
      sourceUuid?: string;
    }
  | { kind: 'system'; id: string; content: string }
  | {
      kind: 'runtime_switch';
      id: string;
      fromKind?: string;
      toKind?: string;
      content: string;
      briefing?: string;
    }
  | { kind: 'reasoning'; id: string; content: string; collapsed: boolean; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      toolUseId?: string;
      name: string;
      status: 'running' | 'complete' | 'error';
      input?: string;
      inputObj?: Record<string, unknown>;
      result?: string;
      collapsed: boolean;
    }
  | {
      kind: 'permission';
      id: string;
      requestId: string;
      description: string;
      permissionType?: string;
      command?: string;
      /** Issue 07/12: plan markdown carried by Plan Approval cards. */
      planMarkdown?: string;
    }
  | {
      kind: 'question';
      id: string;
      toolUseId: string;
      questions: Array<{ question: string; options: QuestionOption[] }>;
    }
  | { kind: 'session_summary'; id: string; diffs: SessionSummaryDiff[] };

const STREAMING_REASONING_ID = '__stream-reasoning__';

const HIDDEN_SYSTEM_SUBTYPES = new Set([
  'init',
  'status',
  'unknown_opencode_part',
  'unknown_opencode_message_role',
]);

const IGNORED_EVENT_TYPES = new Set([
  'content_started',
  'content_finished',
  'tool_input_delta',
  'turn_finished',
  'done',
  'diagnostic',
  'sidecar_debug',
  'sidecar_stream_status',
  'permission_mode_changed',
  'permission_resolved',
  'vision_unsupported',
]);

const INTERACTIVE_CLEAR_EVENT_TYPES = new Set([
  'tool_started',
  'tool_finished',
  'turn_finished',
  'user_message',
  'assistant_message',
]);

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
};

function eventId(event: Record<string, unknown>): string {
  return typeof event.event_id === 'string' ? event.event_id : createId();
}

function eventMetadata(event: Record<string, unknown>): { timestamp?: number; sourceUuid?: string } {
  const timestamp = parseTimestamp(event.timestamp);
  const sourceUuid = typeof event.uuid === 'string'
    ? event.uuid
    : typeof event.event_id === 'string'
      ? event.event_id
      : undefined;
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(sourceUuid ? { sourceUuid } : {}),
  };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function contentBlocks(event: Record<string, unknown>): ContentBlock[] {
  const content = event.content;
  if (Array.isArray(content)) {
    return content.filter((block): block is ContentBlock => Boolean(block) && typeof block === 'object');
  }
  if (content && typeof content === 'object' && Array.isArray((content as { content?: unknown }).content)) {
    return (content as { content: ContentBlock[] }).content;
  }
  return [];
}

function extractUserText(event: Record<string, unknown>): { text: string; attachments: UserAttachmentPreview[] } {
  const content = event.content;
  if (Array.isArray(content)) {
    return extractUserMessageParts(content);
  }

  const blocks = contentBlocks(event);
  if (blocks.length > 0) {
    return extractUserMessageParts(blocks);
  }

  return extractUserMessageParts(content);
}

function formatToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function normalizeToolInput(input: unknown): { display?: string; object?: Record<string, unknown> } {
  if (input === undefined || input === null) return {};
  if (typeof input === 'object' && !Array.isArray(input)) {
    return { display: formatToolInput(input), object: input as Record<string, unknown> };
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { display: formatToolInput(parsed), object: parsed as Record<string, unknown> };
      }
    } catch {
      return { display: input };
    }
    return { display: input };
  }
  return { display: formatToolInput(input) };
}

function parseSessionSummaryDiffs(value: unknown): SessionSummaryDiff[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      file: typeof entry.file === 'string' ? entry.file : 'unknown',
      additions: typeof entry.additions === 'number' ? entry.additions : undefined,
      deletions: typeof entry.deletions === 'number' ? entry.deletions : undefined,
      patch: typeof entry.patch === 'string' ? entry.patch : undefined,
      before: typeof entry.before === 'string' ? entry.before : undefined,
      after: typeof entry.after === 'string' ? entry.after : undefined,
    }))
    .filter((entry) => entry.file !== 'unknown');
}

function parseSystemEvent(event: Record<string, unknown>, id: string): ChatMessage | null {
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';

  if (HIDDEN_SYSTEM_SUBTYPES.has(subtype)) {
    return null;
  }

  if (subtype === 'compact_boundary') {
    const metadata = event.compact_metadata as { pre_tokens?: number; status?: string } | undefined;
    if (metadata?.status === 'compacting') {
      return { kind: 'system', id, content: '— 正在压缩上下文… —' };
    }
    const preTokens = metadata?.pre_tokens ?? 0;
    const tokenText = preTokens >= 1000
      ? ` · 节省 ${(preTokens / 1000).toFixed(1)}k tokens`
      : preTokens > 0
        ? ` · 节省 ${preTokens} tokens`
        : '';
    return { kind: 'system', id, content: `— 上下文已压缩${tokenText} —` };
  }

  if (subtype === 'runtime_switch') {
    return {
      kind: 'runtime_switch',
      id,
      fromKind: typeof event.from_kind === 'string' ? event.from_kind : undefined,
      toKind: typeof event.to_kind === 'string' ? event.to_kind : undefined,
      content: typeof event.content === 'string' && event.content.trim()
        ? event.content
        : '已切换智能体。原生会话已重建。',
      briefing: typeof event.briefing === 'string' ? event.briefing : undefined,
    };
  }

  if (subtype === 'error') {
    const content = typeof event.error === 'string'
      ? event.error
      : typeof event.content === 'string'
        ? event.content
        : null;
    return content ? { kind: 'system', id, content } : null;
  }

  if (subtype === 'api_retry') {
    const attempt = typeof event.attempt === 'number' ? event.attempt : undefined;
    const maxRetries = typeof event.max_retries === 'number' ? event.max_retries : undefined;
    const error = typeof event.error === 'string' ? event.error : '请求重试中';
    const suffix = attempt && maxRetries ? ` (${attempt}/${maxRetries})` : '';
    return { kind: 'system', id, content: `API 重试${suffix}：${error}` };
  }

  if (subtype === 'session_summary') {
    const diffs = parseSessionSummaryDiffs(event.diffs);
    if (diffs.length > 0) {
      return { kind: 'session_summary', id, diffs };
    }
    return null;
  }

  if (typeof event.content === 'string' && event.content.trim()) {
    return { kind: 'system', id, content: event.content };
  }

  return null;
}

function parseAssistantEvent(event: Record<string, unknown>, id: string): ChatMessage[] {
  const blocks = contentBlocks(event);
  if (blocks.length === 0) {
    return [];
  }

  const metadata = eventMetadata(event);
  const messages: ChatMessage[] = [];
  let textParts: string[] = [];

  const flushText = () => {
    const text = textParts.join('\n').trim();
    if (text && !isSwitchBriefingOnlyMessage(text)) {
      messages.push({
        kind: 'assistant',
        id: `${id}-text-${messages.length}`,
        content: text,
        ...metadata,
      });
    }
    textParts = [];
  };

  for (const [index, block] of blocks.entries()) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      flushText();
      messages.push({
        kind: 'reasoning',
        id: `${id}-thinking-${index}`,
        content: block.thinking,
        collapsed: true,
        ...metadata,
      });
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use') {
      flushText();
      const toolUseId = typeof block.id === 'string' ? block.id : undefined;
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const normalized = normalizeToolInput(block.input);
      messages.push({
        kind: 'tool',
        id: toolUseId ?? `${id}-tool-${index}`,
        toolUseId,
        name,
        status: 'running',
        input: normalized.display,
        inputObj: normalized.object,
        collapsed: true,
      });
    }
  }

  flushText();
  return messages;
}

function eventToolName(event: Record<string, unknown>): string | undefined {
  const name = typeof event.name === 'string'
    ? event.name
    : typeof event.tool_name === 'string'
      ? event.tool_name
      : undefined;
  if (!name || name === 'tool') {
    return undefined;
  }
  return name;
}

function mergeToolName(existing: string, incoming?: string): string {
  if (incoming && incoming !== 'tool') {
    return incoming;
  }
  if (existing && existing !== 'tool') {
    return existing;
  }
  return incoming ?? existing ?? 'tool';
}

function buildToolMessage(
  id: string,
  toolUseId: string | undefined,
  name: string,
  status: 'running' | 'complete' | 'error',
  input: unknown,
  result?: string,
): ChatMessage {
  const normalized = normalizeToolInput(input);
  return {
    kind: 'tool',
    id: toolUseId ?? id,
    toolUseId,
    name,
    status,
    input: normalized.display,
    inputObj: normalized.object,
    result,
    collapsed: true,
  };
}

export function eventToMessages(event: Record<string, unknown>): ChatMessage[] {
  const type = typeof event.type === 'string' ? event.type : '';
  const id = eventId(event);

  if (IGNORED_EVENT_TYPES.has(type)) {
    return [];
  }

  if (type === 'user_message') {
    if (isHiddenTranscriptUserMessage(event)) {
      return [];
    }
    const { text, attachments } = extractUserText(event);
    if (!text && attachments.length === 0) {
      return [];
    }
    if (text && (isAgentInjectedUserMessage(text) || isSwitchBriefingOnlyMessage(text))) {
      return [];
    }
    return [{
      kind: 'user',
      id,
      content: text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...eventMetadata(event),
    }];
  }

  if (type === 'assistant_message') {
    if (contentBlocks(event).some((block) => (
      block.type === 'text'
      && typeof block.text === 'string'
      && isCompactSummaryText(block.text)
    ))) {
      return [];
    }
    return parseAssistantEvent(event, id);
  }

  if (type === 'system_event') {
    const message = parseSystemEvent(event, id);
    return message ? [message] : [];
  }

  if (type === 'permission_requested') {
    const description = typeof event.description === 'string' ? event.description : '需要审批';
    const requestId = typeof event.request_id === 'string' ? event.request_id : id;
    const permissionType = typeof event.permission_type === 'string' ? event.permission_type : undefined;
    const metadata = (event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata))
      ? event.metadata as Record<string, unknown>
      : {};
    const command = typeof metadata.command === 'string' && metadata.command.trim()
      ? metadata.command
      : undefined;
    const planMarkdown = isPlanApprovalPermission(permissionType, metadata)
      && typeof metadata.plan === 'string'
      && metadata.plan.trim()
      ? metadata.plan
      : undefined;
    return [{ kind: 'permission', id, requestId, description, permissionType, ...(command ? { command } : {}), ...(planMarkdown ? { planMarkdown } : {}) }];
  }

  if (type === 'user_input_requested') {
    const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : id;
    const questions = Array.isArray(event.questions)
      ? event.questions
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({
            question: typeof entry.question === 'string' ? entry.question : '请回答',
            options: Array.isArray(entry.options)
              ? entry.options
                  .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
                  .map((option) => ({
                    label: typeof option.label === 'string' ? option.label : '选项',
                    description: typeof option.description === 'string' ? option.description : undefined,
                  }))
              : [],
          }))
      : [];
    return [{ kind: 'question', id, toolUseId, questions }];
  }

  if (type === 'tool_started') {
    const name = eventToolName(event) ?? 'tool';
    const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : undefined;
    return [buildToolMessage(id, toolUseId, name, 'running', event.input)];
  }

  if (type === 'tool_finished') {
    const name = eventToolName(event) ?? 'tool';
    const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : undefined;
    const isError = event.is_error === true;
    return [buildToolMessage(
      id,
      toolUseId,
      name,
      isError ? 'error' : 'complete',
      event.input,
      typeof event.content === 'string' ? event.content : formatToolInput(event.content),
    )];
  }

  if (type === 'reasoning_delta' && typeof event.text === 'string') {
    return [{
      kind: 'reasoning',
      id: STREAMING_REASONING_ID,
      content: event.text,
      collapsed: true,
      streaming: true,
      ...eventMetadata(event),
    }];
  }

  if (type === 'text_delta' && typeof event.text === 'string') {
    return [{
      kind: 'assistant',
      id: `${id}-delta`,
      content: event.text,
      streaming: true,
      ...eventMetadata(event),
    }];
  }

  if (type === 'error') {
    const content = typeof event.error === 'string'
      ? event.error
      : typeof event.message === 'string'
        ? event.message
        : '发生错误';
    return [{ kind: 'system', id, content }];
  }

  if (type === 'sidecar_stream_status') {
    const message = typeof event.message === 'string' ? event.message : '连接状态变更';
    return [{ kind: 'system', id, content: message }];
  }

  return [];
}

function withoutStreamingPlaceholders(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => (
    !(message.kind === 'assistant' && message.streaming)
    && !(message.kind === 'reasoning' && message.id === STREAMING_REASONING_ID)
  ));
}

export function appendMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (incoming.kind === 'assistant' && incoming.streaming) {
    const last = messages[messages.length - 1];
    if (last?.kind === 'assistant' && last.streaming) {
      return [...messages.slice(0, -1), { ...last, content: last.content + incoming.content }];
    }
    return [...messages, incoming];
  }

  if (incoming.kind === 'assistant' && !incoming.streaming) {
    const base = withoutStreamingPlaceholders(messages);
    const duplicate = base.some((message) => message.id === incoming.id);
    if (duplicate) return base;
    return [...base, { ...incoming, streaming: false }];
  }

  if (incoming.kind === 'reasoning') {
    if (incoming.streaming) {
      const last = messages[messages.length - 1];
      if (last?.kind === 'reasoning' && last.id === STREAMING_REASONING_ID) {
        return [...messages.slice(0, -1), { ...last, content: last.content + incoming.content }];
      }
      return [...messages, incoming];
    }

    const base = messages.filter((message) => !(message.kind === 'reasoning' && message.id === STREAMING_REASONING_ID));
    const duplicate = base.some((message) => message.id === incoming.id);
    if (duplicate) return base;
    return [...base, { ...incoming, streaming: false }];
  }

  if (incoming.kind === 'tool') {
    const index = messages.findIndex(
      (message) => message.kind === 'tool' && (
        (incoming.toolUseId && message.toolUseId === incoming.toolUseId)
        || message.id === incoming.id
      ),
    );
    if (index >= 0) {
      const existing = messages[index];
      if (existing.kind !== 'tool') return messages;
      const merged: ChatMessage = {
        ...existing,
        name: mergeToolName(existing.name, incoming.name),
        status: incoming.status === 'running' ? existing.status : incoming.status,
        input: incoming.input ?? existing.input,
        inputObj: incoming.inputObj ?? existing.inputObj,
        result: incoming.result ?? existing.result,
      };
      return [...messages.slice(0, index), merged, ...messages.slice(index + 1)];
    }
    return [...messages, incoming];
  }

  const duplicate = messages.some((message) => message.id === incoming.id);
  if (duplicate) return messages;

  if (incoming.kind === 'user') {
    const lastUser = [...messages].reverse().find((message) => message.kind === 'user');
    if (lastUser?.content === incoming.content) {
      return messages;
    }
  }

  return [...messages, incoming];
}

function clearResolvedInteractivePrompts(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.kind !== 'permission' && message.kind !== 'question');
}

function clearResolvedRequestPrompts(messages: ChatMessage[], event: Record<string, unknown>): ChatMessage[] {
  const requestId = typeof event.request_id === 'string' ? event.request_id : '';
  if (!requestId) {
    return messages;
  }
  return messages.filter((message) => {
    if (message.kind === 'permission') {
      return message.requestId !== requestId;
    }
    if (message.kind === 'question') {
      return message.toolUseId !== requestId;
    }
    return true;
  });
}

function finalizeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.kind === 'assistant' && message.streaming) {
      return { ...message, streaming: false };
    }
    if (message.kind === 'reasoning' && message.streaming) {
      return { ...message, streaming: false };
    }
    return message;
  });
}

export function appendEvent(messages: ChatMessage[], event: Record<string, unknown>): ChatMessage[] {
  const type = typeof event.type === 'string' ? event.type : '';
  const shouldClearInteractive = INTERACTIVE_CLEAR_EVENT_TYPES.has(type);
  let base = shouldClearInteractive ? clearResolvedInteractivePrompts(messages) : messages;
  if (type === 'turn_finished') {
    base = finalizeStreamingMessages(base);
  }
  if (type === 'permission_resolved') {
    // Issue 12: another surface (desktop) resolved the request — drop the
    // matching pending permission/question prompt instead of waiting for the
    // next turn event.
    base = clearResolvedRequestPrompts(base, event);
  }
  return eventToMessages(event).reduce((current, message) => appendMessage(current, message), base);
}

export function eventsToMessages(events: unknown[]): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const event of events) {
    if (event && typeof event === 'object') {
      messages = appendEvent(messages, event as Record<string, unknown>);
    }
  }
  return messages;
}
