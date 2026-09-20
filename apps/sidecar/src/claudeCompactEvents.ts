import type { AgentInputPayload } from './agentInputPayload.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isManualCompactPrompt(prompt: string, inputPayload?: AgentInputPayload): boolean {
  const text = (inputPayload?.text ?? prompt).trim();
  return text === '/compact' && (inputPayload?.images?.length ?? 0) === 0;
}

export function readClaudeCompactPreTokens(message: Record<string, unknown>): number | undefined {
  return readNumber(message.tokens)
    ?? readNumber(message.pre_tokens)
    ?? readNumber(message.total_tokens);
}

export function buildClaudeCompactBoundaryEvent(
  sessionId: string,
  status: 'compacting' | 'completed',
  metadata: {
    trigger?: 'manual' | 'auto';
    pre_tokens?: number;
    post_tokens?: number;
  } = {},
): Record<string, unknown> {
  return {
    type: 'system_event',
    subtype: 'compact_boundary',
    session_id: sessionId,
    event_id: crypto.randomUUID(),
    content: 'Conversation compacted',
    compact_metadata: {
      trigger: metadata.trigger ?? 'manual',
      status,
      pre_tokens: metadata.pre_tokens ?? 0,
      ...(metadata.post_tokens !== undefined ? { post_tokens: metadata.post_tokens } : {}),
    },
  };
}

export function normalizeClaudeCompactBoundaryMessage(
  message: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  const metadata = asRecord(message.compact_metadata) ?? asRecord(message.compactMetadata);
  const trigger = metadata?.trigger === 'auto' ? 'auto' : 'manual';
  const preTokens = readNumber(metadata?.pre_tokens) ?? readNumber(metadata?.preTokens) ?? 0;
  const postTokens = readNumber(metadata?.post_tokens) ?? readNumber(metadata?.postTokens);

  return {
    ...message,
    type: 'system_event',
    event_id: typeof message.uuid === 'string' ? message.uuid : crypto.randomUUID(),
    ...(sessionId ? { session_id: sessionId } : {}),
    compact_metadata: {
      ...(metadata ?? {}),
      trigger,
      status: 'completed',
      pre_tokens: preTokens,
      ...(postTokens !== undefined ? { post_tokens: postTokens } : {}),
    },
  };
}
