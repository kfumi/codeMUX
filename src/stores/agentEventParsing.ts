import type {
  AgentAssistantMessage,
  AgentResultMessage,
  AgentToolResult,
} from '../types/agent';
import type { AgentKind } from '../types/session';
import { formatPromptAsCommandDisplay } from '../lib/slashCommands';
import type { UserAttachmentPreview } from '../types/agentInput';

export const INTERRUPT_MARKER = '[Request interrupted by user]';

export type ParsedStoreEvent =
  | { kind: 'user'; data: { content: string; attachments?: UserAttachmentPreview[] } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'result'; data: AgentResultMessage }
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
    return {
      kind: 'user',
      data: { content: message.content },
    };
  }

  const textParts = content
    ?.filter((block) => isRecord(block) && block.type === 'text')
    .map((block) => String(block.text || ''))
    .filter((text) => text.length > 0) ?? [];
  const attachments = extractImageAttachments(content ?? []);

  return {
    kind: 'user',
    data: {
      content: textParts.join('\n'),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

function extractImageAttachments(content: unknown[]): UserAttachmentPreview[] {
  const attachments: UserAttachmentPreview[] = [];

  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') {
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
    const dataUrl = sourceType === 'base64' && mediaType && data
      ? `data:${mediaType};base64,${data}`
      : typeof source?.url === 'string' && source.url.startsWith('data:image/')
        ? source.url
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
    (
      normalized.startsWith('# AGENTS.md instructions for ') &&
      normalized.includes('<INSTRUCTIONS>')
    ) ||
    (
      normalized.startsWith('Base directory for this skill: ') &&
      normalized.includes('<SUBAGENT-STOP>')
    )
  );
}

export function mapPersistedClaudeMessage(raw: Record<string, unknown>, agentKind: AgentKind = 'claude_code'): ParsedStoreEvent | null {
  const msgType = raw.type;

  if (msgType === 'assistant') {
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
    const event = parseSdkUserMessage(raw);
    if (event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)) {
      return null;
    }

    if (event.kind !== 'user' || agentKind !== 'codex') {
      return event;
    }

    return {
      ...event,
      data: {
        ...event.data,
        content: formatPromptAsCommandDisplay(event.data.content, agentKind) ?? event.data.content,
      },
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
