const ATTACHMENT_CONTEXT_BLOCK_PATTERN = /<attachment_context>[\s\S]*?<\/attachment_context>\s*/gi;
const CODEX_COLLABORATION_POLICY_RE = /<codemux-codex-collaboration-policy>[\s\S]*?<\/codemux-codex-collaboration-policy>\s*/g;
const CLAUDE_COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.';
const CODEX_COMPACT_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary';
const CLAUDE_LOCAL_COMPACT_STDOUT_RE = /^\s*<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>\s*$/i;

export interface UserAttachmentPreview {
  dataUrl: string;
  mediaType?: string;
  name?: string;
}

export function stripAttachmentEnrichmentContext(text: string): string {
  return text.replace(ATTACHMENT_CONTEXT_BLOCK_PATTERN, '').trim();
}

export function stripCodexCollaborationPolicyBlock(text: string): string {
  return text.replace(CODEX_COLLABORATION_POLICY_RE, '').trimStart();
}

export function stripSwitchBriefingPrefix(text: string): string {
  const normalized = text.trimStart();
  if (!normalized.startsWith('[CodeMUX runtime switch]')) {
    return text;
  }

  const separator = '\n---\nUser follow-up:\n';
  const separatorIndex = normalized.indexOf(separator);
  if (separatorIndex === -1) {
    return '';
  }

  return normalized.slice(separatorIndex + separator.length);
}

export function isSwitchBriefingOnlyMessage(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized.startsWith('[CodeMUX runtime switch]')) {
    return false;
  }
  return stripSwitchBriefingPrefix(text).trim().length === 0;
}

export function isAgentInjectedUserMessage(text: string): boolean {
  const normalized = text.trimStart();
  return (
    (
      normalized.startsWith('# AGENTS.md instructions for ')
      && normalized.includes('<INSTRUCTIONS>')
    )
    || normalized.startsWith('Base directory for this skill: ')
  );
}

export function isHiddenTranscriptUserMessage(event: Record<string, unknown>): boolean {
  if (event.isCompactSummary === true || event.isVisibleInTranscriptOnly === true) {
    return true;
  }

  const content = event.content;
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.filter((block): block is Record<string, unknown> => (
      Boolean(block) && typeof block === 'object' && !Array.isArray(block)
    ));
    if (blocks.length === content.length && blocks.every((block) => block.type === 'tool_result')) {
      return true;
    }
  }

  const text = typeof content === 'string'
    ? content.trimStart()
    : extractUserMessageParts(content).text.trimStart();
  return (
    isCompactSummaryText(text)
    || text === '/compact'
    || CLAUDE_LOCAL_COMPACT_STDOUT_RE.test(text)
    || text.startsWith('<task-notification>')
  );
}

export function isCompactSummaryText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith(CLAUDE_COMPACT_SUMMARY_PREFIX)
    || normalized.startsWith(CODEX_COMPACT_SUMMARY_PREFIX);
}

export function formatUserMessageText(text: string): string {
  return stripSwitchBriefingPrefix(
    stripAttachmentEnrichmentContext(
      stripCodexCollaborationPolicyBlock(text),
    ),
  );
}

type ContentBlock = {
  type?: string;
  text?: string;
  source?: Record<string, unknown>;
  image_url?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function extractImageAttachments(content: unknown[]): UserAttachmentPreview[] {
  const attachments: UserAttachmentPreview[] = [];

  for (const block of content) {
    if (!isRecord(block) || (block.type !== 'image' && block.type !== 'input_image')) {
      continue;
    }

    const source = isRecord(block.source) ? block.source : undefined;
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
      dataUrl,
      mediaType,
      name: typeof block.name === 'string' ? block.name : undefined,
    });
  }

  return attachments;
}

export function extractUserMessageParts(content: unknown): { text: string; attachments: UserAttachmentPreview[] } {
  if (typeof content === 'string') {
    return { text: formatUserMessageText(content), attachments: [] };
  }

  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }

  const blocks = content.filter((block): block is ContentBlock => isRecord(block));
  const textParts = blocks
    .filter((block) => block.type === 'text' || block.type === 'input_text')
    .map((block) => formatUserMessageText(String(block.text ?? '')))
    .filter((text) => text.length > 0);

  return {
    text: textParts.join('\n'),
    attachments: extractImageAttachments(blocks),
  };
}
