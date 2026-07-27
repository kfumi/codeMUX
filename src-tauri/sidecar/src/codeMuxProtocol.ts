export type CodeMuxStreamEvent =
  | {
      type: 'content_started';
      session_id?: string;
      index: number;
      content_kind: 'text' | 'reasoning';
      event_id: string;
    }
  | {
      type: 'text_delta' | 'reasoning_delta';
      session_id?: string;
      index: number;
      text: string;
      event_id: string;
    }
  | {
      type: 'content_finished';
      session_id?: string;
      index: number;
      event_id: string;
    };

export function toCodeMuxStreamEvent(
  sessionId: string | undefined,
  event: unknown,
  eventIdFactory: () => string = () => crypto.randomUUID(),
): CodeMuxStreamEvent | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const value = event as Record<string, unknown>;
  const index = typeof value.index === 'number' ? value.index : 0;

  if (value.type === 'content_block_start') {
    const contentBlock = value.content_block;
    const contentKind = contentBlock && typeof contentBlock === 'object' && !Array.isArray(contentBlock)
      && (contentBlock as Record<string, unknown>).type === 'thinking'
      ? 'reasoning'
      : 'text';
    return withLegacyProjection(
      { type: 'content_started', session_id: sessionId, index, content_kind: contentKind, event_id: eventIdFactory() },
      value,
    );
  }

  if (value.type === 'content_block_stop') {
    return withLegacyProjection({ type: 'content_finished', session_id: sessionId, index, event_id: eventIdFactory() }, value);
  }

  if (value.type !== 'content_block_delta' || !value.delta || typeof value.delta !== 'object' || Array.isArray(value.delta)) {
    return undefined;
  }

  const delta = value.delta as Record<string, unknown>;
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return withLegacyProjection({ type: 'text_delta', session_id: sessionId, index, text: delta.text, event_id: eventIdFactory() }, value);
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return withLegacyProjection({ type: 'reasoning_delta', session_id: sessionId, index, text: delta.thinking, event_id: eventIdFactory() }, value);
  }
  return undefined;
}

function withLegacyProjection<T extends CodeMuxStreamEvent>(event: T, legacyEvent: Record<string, unknown>): T & { event: unknown } {
  Object.defineProperty(event, 'event', { value: legacyEvent, enumerable: true });
  Object.defineProperty(event, 'toJSON', {
    value: () => {
      const { event: _legacyEvent, ...wireEvent } = event as T & { event: unknown };
      return wireEvent;
    },
  });
  return event as T & { event: unknown };
}

export function isCodeMuxStreamEvent(value: unknown): value is CodeMuxStreamEvent {
  return Boolean(value) && typeof value === 'object' && ['content_started', 'text_delta', 'reasoning_delta', 'content_finished'].includes((value as { type?: unknown }).type as string);
}
