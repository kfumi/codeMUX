import type {
  AgentAssistantMessage,
  AgentResultMessage,
  AgentToolResult,
  AgentUserMessageLocator,
} from '../types/agent';
import type { AgentKind } from '../types/session';
import { formatPromptAsCommandDisplay } from '../lib/slashCommands';
import type { UserAttachmentPreview } from '../types/agentInput';

export const INTERRUPT_MARKER = '[Request interrupted by user]';

const CODEX_COLLABORATION_POLICY_RE = /<codemux-codex-collaboration-policy>[\s\S]*?<\/codemux-codex-collaboration-policy>\s*/g;

export type ParsedStoreEvent =
  | { kind: 'user'; data: { content: string; attachments?: UserAttachmentPreview[]; locator?: AgentUserMessageLocator } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'compact'; data: { compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number }; subtype: string; type: string } }
  | { kind: 'file_snapshot'; data: { type: 'file_snapshot'; file_path: string; original_content: string; is_new: boolean; tool_use_id: string } };

export function isInterruptMarker(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === INTERRUPT_MARKER || trimmed.startsWith('[Request interrupted by user');
}

export function shouldSuppressLiveEventWhileStopped(kind: string): boolean {
  return kind !== 'done' && kind !== 'error';
}

export function isTerminalAgentEvent(kind: string, _isResultError = false): boolean {
  return kind === 'done' || kind === 'error' || kind === 'result';
}

export function shouldProcessTerminalEvent(
  isRunning: boolean,
  kind: string,
  isResultError = false,
): boolean {
  if (!isTerminalAgentEvent(kind, isResultError)) {
    return true;
  }

  return isRunning;
}

export function parseSdkUserMessage(data: Record<string, unknown>): ParsedStoreEvent {
  const message = asRecord(data.message);
  const content = Array.isArray(message?.content) ? message.content : undefined;

  if (content?.some((block) => isRecord(block) && block.type === 'tool_result')) {
    return { kind: 'tool_result', data: data as unknown as AgentToolResult };
  }

  if (typeof message?.content === 'string') {
    const contentText = stripCodexCollaborationPolicyBlock(message.content);
    return {
      kind: 'user',
      data: {
        content: contentText,
        ...buildUserLocator(data, contentText),
      },
    };
  }

  const textParts = content
    ?.filter((block) => isRecord(block) && (block.type === 'text' || block.type === 'input_text'))
    .map((block) => stripCodexCollaborationPolicyBlock(String(block.text || '')))
    .filter((text) => text.length > 0) ?? [];
  const attachments = extractImageAttachments(content ?? []);

  return {
    kind: 'user',
    data: {
      content: textParts.join('\n'),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...buildUserLocator(data, textParts.join('\n')),
    },
  };
}

function buildUserLocator(raw: Record<string, unknown>, text: string): { locator?: AgentUserMessageLocator } {
  const providerMessageId = [
    raw.uuid,
    raw.id,
    raw.message_id,
    raw.messageId,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value.length > 0);

  const lineIndex = readNumber(raw.__lineIndex) ?? readNumber(raw.lineIndex);
  const sourceEventIndex = readNumber(raw.sourceEventIndex);
  const turnOrdinal = readNumber(raw.turnOrdinal);

  if (!providerMessageId && lineIndex === undefined && sourceEventIndex === undefined && turnOrdinal === undefined) {
    return {};
  }

  return {
    locator: {
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(lineIndex !== undefined ? { lineIndex } : {}),
      ...(sourceEventIndex !== undefined ? { sourceEventIndex } : {}),
      role: 'user',
      textFingerprint: fingerprintUserText(text),
      ...(turnOrdinal !== undefined ? { turnOrdinal } : {}),
    },
  };
}

function fingerprintUserText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

function extractImageAttachments(content: unknown[]): UserAttachmentPreview[] {
  const attachments: UserAttachmentPreview[] = [];

  for (const block of content) {
    if (!isRecord(block) || (block.type !== 'image' && block.type !== 'input_image')) {
      continue;
    }

    const source = asRecord(block.source);
    const mediaType = typeof source?.media_type === 'string'
      ? source.media_type
      : typeof source?.mediaType === 'string'
        ? source.mediaType
        : undefined;
    const data = typeof source?.data === 'string' ? source.data : undefined;
    const sourceType = typeof source?.type === 'string' ? source.type : undefined;
    const imageUrl = typeof block.image_url === 'string' ? block.image_url : undefined;
    const dataUrl = sourceType === 'base64' && mediaType && data
      ? `data:${mediaType};base64,${data}`
      : typeof source?.url === 'string' && source.url.startsWith('data:image/')
        ? source.url
        : imageUrl?.startsWith('data:image/')
          ? imageUrl
          : undefined;

    if (!dataUrl) {
      continue;
    }

    attachments.push({
      type: 'image',
      name: typeof block.name === 'string' && block.name.trim()
        ? block.name
        : `image-${attachments.length + 1}.${extensionForMediaType(mediaTypeFromDataUrl(dataUrl) ?? mediaType ?? 'image/png')}`,
      mediaType: mediaTypeFromDataUrl(dataUrl) ?? mediaType ?? 'image/png',
      dataUrl,
    });
  }

  return attachments;
}

function mediaTypeFromDataUrl(dataUrl: string): string | undefined {
  return dataUrl.match(/^data:([^;,]+)[;,]/)?.[1];
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/png':
    default:
      return 'png';
  }
}

export function isAgentInjectedUserMessage(text: string): boolean {
  const normalized = text.trimStart();
  return (
    // AGENTS.md injection
    (
      normalized.startsWith('# AGENTS.md instructions for ') &&
      normalized.includes('<INSTRUCTIONS>')
    ) ||
    // Skill base directory injection
    (
      normalized.startsWith('Base directory for this skill: ')
    )
  );
}

export function stripCodexCollaborationPolicyBlock(text: string): string {
  return text.replace(CODEX_COLLABORATION_POLICY_RE, '').trimStart();
}

/**
 * Check if a raw persisted event is a meta message (e.g. slash command auto-generated prompts).
 * Claude Code marks these with `isMeta: true` in the JSONL.
 */
export function isMetaPersistedEvent(raw: Record<string, unknown>): boolean {
  return raw.isMeta === true;
}

export function isClaudeSubagentEvent(raw: Record<string, unknown>): boolean {
  return raw.isSidechain === true
    || (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0);
}

export function isClaudeTaskNotificationEvent(raw: Record<string, unknown>): boolean {
  const origin = asRecord(raw.origin);
  return (
    origin?.kind === 'task-notification' ||
    origin?.kind === 'task_notification' ||
    (raw.type === 'system' && raw.subtype === 'task_notification')
  );
}

export function isClaudeTaskNotificationUserEvent(data: Record<string, unknown>): boolean {
  const origin = asRecord(data.origin);
  const content = typeof data.content === 'string' ? data.content.trimStart() : '';

  return (
    origin?.kind === 'task-notification' ||
    origin?.kind === 'task_notification' ||
    content.startsWith('<task-notification>')
  );
}

function isSyntheticNoResponseAssistantEvent(raw: Record<string, unknown>): boolean {
  const message = asRecord(raw.message);
  if (message?.stop_reason !== 'stop_sequence') {
    return false;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  const textParts = content
    .filter((block) => isRecord(block) && block.type === 'text')
    .map((block) => String(block.text || '').trim())
    .filter(Boolean);

  return textParts.length === 1 && textParts[0] === 'No response requested.';
}

const CLAUDE_LOCAL_COMPACT_STDOUT_RE = /^\s*<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>\s*$/;
const CLAUDE_COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.';
const CODEX_COMPACT_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary';

/**
 * Detects whether content is a pure Claude CLI command XML echo
 * (e.g. `<command-message>...</command-name>...`). Only matches when the
 * entire trimmed content is the XML block — not when XML is embedded in
 * surrounding text.
 */
export function isClaudeCommandXmlEcho(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('<command-message>') && !trimmed.startsWith('<command-name>')) {
    return false;
  }
  const endsWithTag =
    trimmed.endsWith('</command-args>') ||
    trimmed.endsWith('</command-name>') ||
    trimmed.endsWith('</command-message>');
  return endsWithTag && trimmed.includes('<command-name>');
}

/**
 * Converts a pure Claude CLI command XML echo into `/command args` display
 * form so it can be rendered as a chip and edited in the composer on rewind.
 * Returns null if the content is not a pure command XML echo.
 */
export function convertClaudeCommandXmlToDisplay(content: string): string | null {
  const trimmed = content.trim();
  if (!isClaudeCommandXmlEcho(trimmed)) {
    return null;
  }
  const nameMatch = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/.exec(trimmed);
  if (!nameMatch) {
    return null;
  }
  const argsMatch = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(trimmed);
  const commandName = nameMatch[1].trim().replace(/^\//, '');
  const commandArgs = argsMatch?.[1]?.trim() || '';
  return `/${commandName}${commandArgs ? ` ${commandArgs}` : ''}`;
}

export function normalizeClaudeUserEvent(
  event: Extract<ParsedStoreEvent, { kind: 'user' }>,
): Extract<ParsedStoreEvent, { kind: 'user' }> | null {
  const content = event.data.content;
  if (isClaudeLocalCompactStdout(content)) {
    return null;
  }
  // Filter out Claude CLI's XML command echo — the local display message
  // (added by startQuery) is already in the store, so the echo is redundant.
  if (isClaudeCommandXmlEcho(content)) {
    return null;
  }

  return { ...event, data: { ...event.data, content } };
}

export function isClaudeCompactSummaryText(content: string): boolean {
  return content.trimStart().startsWith(CLAUDE_COMPACT_SUMMARY_PREFIX);
}

export function isCodexCompactSummaryText(content: string): boolean {
  const text = content.trimStart();
  return text.startsWith(CODEX_COMPACT_SUMMARY_PREFIX)
    || text.startsWith(CLAUDE_COMPACT_SUMMARY_PREFIX);
}

export function isClaudeCompactSummaryRawEvent(raw: Record<string, unknown>): boolean {
  return isClaudeCompactSummaryEvent(raw);
}

function isClaudeLocalCompactStdout(content: string): boolean {
  return CLAUDE_LOCAL_COMPACT_STDOUT_RE.test(content);
}

function isClaudeCompactSummaryEvent(raw: Record<string, unknown>): boolean {
  if (raw.isCompactSummary === true) {
    return true;
  }

  if (isClaudeCompactSummaryText(getRawUserText(raw))) {
    return true;
  }

  return raw.isVisibleInTranscriptOnly === true;
}

function getRawUserText(raw: Record<string, unknown>): string {
  const message = asRecord(raw.message);
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => isRecord(block) && block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n');
}

function mapCompactBoundary(raw: Record<string, unknown>): Extract<ParsedStoreEvent, { kind: 'compact' }> | null {
  if (raw.type !== 'system' || raw.subtype !== 'compact_boundary') {
    return null;
  }

  const metadata = asRecord(raw.compact_metadata) ?? asRecord(raw.compactMetadata);
  const trigger = metadata?.trigger === 'auto' ? 'auto' : 'manual';
  const preTokens = readNumber(metadata?.pre_tokens) ?? readNumber(metadata?.preTokens) ?? 0;

  return {
    kind: 'compact',
    data: {
      ...(raw as Record<string, unknown>),
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        ...(metadata ?? {}),
        trigger,
        pre_tokens: preTokens,
      },
    } as Extract<ParsedStoreEvent, { kind: 'compact' }>['data'],
  };
}

export function mapCodexCompactedEvent(raw: Record<string, unknown>): Extract<ParsedStoreEvent, { kind: 'compact' }> | null {
  if (raw.type !== 'compacted') {
    return null;
  }

  const payload = asRecord(raw.payload);
  const trigger = payload?.trigger === 'manual' ? 'manual' : 'auto';
  const preTokens = readNumber(payload?.pre_tokens) ?? readNumber(payload?.preTokens) ?? 0;
  const postTokens = readNumber(payload?.post_tokens) ?? readNumber(payload?.postTokens) ?? 0;

  return {
    kind: 'compact',
    data: {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      ...(raw.timestamp !== undefined ? { timestamp: raw.timestamp } : {}),
      ...(raw.session_id !== undefined ? { session_id: raw.session_id } : {}),
      compact_metadata: {
        ...(payload ?? {}),
        trigger,
        pre_tokens: preTokens,
        post_tokens: postTokens,
      },
    } as Extract<ParsedStoreEvent, { kind: 'compact' }>['data'],
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function mapPersistedClaudeMessage(
  raw: Record<string, unknown>,
  agentKind: AgentKind = 'claude_code',
): ParsedStoreEvent | null {
  const codeMuxProjection = projectCodeMuxHistoryEvent(raw);
  if (codeMuxProjection) {
    return mapPersistedClaudeMessage(codeMuxProjection, agentKind);
  }

  if (isClaudeSubagentEvent(raw)) {
    return null;
  }

  if (isClaudeTaskNotificationEvent(raw)) {
    return null;
  }

  // Skip meta messages (slash command auto-generated prompts like /code-review)
  if (isMetaPersistedEvent(raw)) {
    return null;
  }

  const msgType = raw.type;

  const codexCompactedEvent = mapCodexCompactedEvent(raw);
  if (codexCompactedEvent) {
    return codexCompactedEvent;
  }

  const compactEvent = mapCompactBoundary(raw);
  if (compactEvent) {
    return compactEvent;
  }

  if (msgType === 'assistant') {
    if (isSyntheticNoResponseAssistantEvent(raw)) {
      return null;
    }

    return { kind: 'assistant', data: raw as unknown as AgentAssistantMessage };
  }

  if (msgType === 'result') {
    return { kind: 'result', data: raw as unknown as AgentResultMessage };
  }

  if (msgType === 'file_snapshot') {
    return {
      kind: 'file_snapshot',
      data: raw as { type: 'file_snapshot'; file_path: string; original_content: string; is_new: boolean; tool_use_id: string },
    };
  }

  if (msgType === 'user') {
    if (isClaudeCompactSummaryEvent(raw)) {
      return null;
    }

    const event = parseSdkUserMessage(raw);
    if (event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)) {
      return null;
    }

    if (event.kind !== 'user') {
      return event;
    }

    // For persisted Claude Code messages, convert the CLI's XML command echo
    // into `/command args` display form. This runs before normalizeClaudeUserEvent
    // (which would filter the XML out) because persisted history has no local
    // display message — the XML echo is the only record of the command.
    if (agentKind === 'claude_code') {
      const converted = convertClaudeCommandXmlToDisplay(event.data.content);
      if (converted !== null) {
        return { ...event, data: { ...event.data, content: converted } };
      }
    }

    // Strip Claude CLI's internal XML command tags from persisted messages
    let normalizedUserEvent: typeof event | null = event;
    if (agentKind === 'claude_code') {
      normalizedUserEvent = normalizeClaudeUserEvent(event);
    }
    if (!normalizedUserEvent) {
      return null;
    }

    const content = normalizedUserEvent.data.content;

    // Try to reverse-map prompt templates back to slash command display form
    const displayContent = formatPromptAsCommandDisplay(content, agentKind);
    if (displayContent && displayContent !== content) {
      return { ...normalizedUserEvent, data: { ...normalizedUserEvent.data, content: displayContent } };
    }

    return { ...normalizedUserEvent, data: { ...normalizedUserEvent.data, content } };
  }

  return null;
}

function projectCodeMuxHistoryEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type === 'assistant_message') {
    return {
      type: 'assistant',
      uuid: raw.event_id,
      session_id: raw.session_id,
      timestamp: raw.timestamp,
      message: {
        role: 'assistant',
        content: raw.content,
        ...(isRecord(raw.usage) ? { usage: raw.usage } : {}),
        ...(typeof raw.stop_reason === 'string' ? { stop_reason: raw.stop_reason } : {}),
      },
    };
  }
  if (raw.type === 'user_message') {
    return {
      type: 'user',
      uuid: raw.provider_message_id ?? raw.event_id,
      session_id: raw.session_id,
      timestamp: raw.timestamp,
      ...(raw.line_index !== undefined ? { __lineIndex: raw.line_index } : {}),
      ...(raw.source_event_index !== undefined ? { sourceEventIndex: raw.source_event_index } : {}),
      ...(raw.turn_ordinal !== undefined ? { turnOrdinal: raw.turn_ordinal } : {}),
      message: { role: 'user', content: raw.content },
    };
  }
  if (raw.type === 'system_event') {
    return {
      type: 'system',
      subtype: raw.subtype,
      timestamp: raw.timestamp,
      session_id: raw.session_id,
      content: raw.content,
      compact_metadata: raw.compact_metadata,
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
