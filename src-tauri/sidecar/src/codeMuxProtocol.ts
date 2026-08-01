export type CodeMuxStreamEvent =
  | {
      type: 'content_started';
      session_id?: string;
      index: number;
      content_kind: 'text' | 'reasoning';
      event_id: string;
      sequence?: number;
    }
  | {
      type: 'text_delta' | 'reasoning_delta';
      session_id?: string;
      index: number;
      text: string;
      event_id: string;
      sequence?: number;
    }
  | {
      type: 'tool_input_delta';
      session_id?: string;
      index: number;
      partial_json: string;
      event_id: string;
      sequence?: number;
    }
  | {
      type: 'content_finished';
      session_id?: string;
      index: number;
      event_id: string;
      sequence?: number;
    };

export type CodeMuxToolEvent =
  | {
      type: 'tool_started';
      session_id?: string;
      tool_use_id: string;
      name: string;
      input: Record<string, unknown>;
      event_id: string;
      sequence: number;
    }
  | {
      type: 'tool_finished';
      session_id?: string;
      tool_use_id: string;
      content: string;
      is_error: boolean;
      event_id: string;
      sequence: number;
    };

export type CodeMuxAssistantMessageEvent = {
  type: 'assistant_message';
  session_id?: string;
  content: Array<Record<string, unknown>>;
  provider_message_id?: string;
  supersedes_provider_message_ids?: string[];
  event_id: string;
  sequence: number;
};

export type CodeMuxUserMessageEvent = {
  type: 'user_message';
  session_id?: string;
  content: string | Array<Record<string, unknown>>;
  provider_message_id?: string;
  line_index?: number;
  source_event_index?: number;
  turn_ordinal?: number;
  event_id: string;
  sequence: number;
};

export type CodeMuxSystemEvent = {
  type: 'system_event';
  session_id?: string;
  subtype: string;
  content?: string;
  compact_metadata?: Record<string, unknown>;
  event_id: string;
  sequence: number;
  [key: string]: unknown;
};

export type CodeMuxDiagnosticEvent = {
  type: 'diagnostic';
  session_id?: string;
  subtype: string;
  error?: string;
  event_type?: string;
  event_id: string;
  sequence: number;
  [key: string]: unknown;
};

export type CodeMuxQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; value?: unknown }>;
  multiSelect?: boolean;
  allowOther?: boolean;
};

export type CodeMuxUserInputRequestedEvent = {
  type: 'user_input_requested';
  session_id?: string;
  tool_use_id: string;
  questions: CodeMuxQuestion[];
  event_id: string;
  sequence: number;
};

export type CodeMuxPermissionRequestedEvent = {
  type: 'permission_requested';
  session_id?: string;
  request_id: string;
  permission_id?: string;
  permission_type: string;
  description: string;
  metadata?: Record<string, unknown>;
  event_id: string;
  sequence: number;
};

export type CodeMuxTurnEvent =
  | {
      type: 'error';
      session_id?: string;
      subtype: string;
      error: string;
      event_id: string;
      sequence: number;
    }
  | {
      type: 'turn_finished';
      session_id?: string;
      outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled';
      reason?: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens: number;
        reasoning_output_tokens: number;
      };
      duration_ms?: number;
      event_id: string;
      sequence: number;
    };

export type CodeMuxRuntimeEvent = CodeMuxStreamEvent | CodeMuxToolEvent | CodeMuxAssistantMessageEvent | CodeMuxUserMessageEvent | CodeMuxSystemEvent | CodeMuxDiagnosticEvent | CodeMuxUserInputRequestedEvent | CodeMuxPermissionRequestedEvent | CodeMuxTurnEvent;

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
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    return withLegacyProjection({ type: 'tool_input_delta', session_id: sessionId, index, partial_json: delta.partial_json, event_id: eventIdFactory() }, value);
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
  return Boolean(value) && typeof value === 'object' && ['content_started', 'text_delta', 'reasoning_delta', 'tool_input_delta', 'content_finished'].includes((value as { type?: unknown }).type as string);
}

export function isCodeMuxToolEvent(value: unknown): value is CodeMuxToolEvent {
  return Boolean(value) && typeof value === 'object' && ['tool_started', 'tool_finished'].includes((value as { type?: unknown }).type as string);
}

export function isCodeMuxAssistantMessageEvent(value: unknown): value is CodeMuxAssistantMessageEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'assistant_message';
}

export function isCodeMuxUserMessageEvent(value: unknown): value is CodeMuxUserMessageEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'user_message';
}

export function isCodeMuxSystemEvent(value: unknown): value is CodeMuxSystemEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'system_event';
}

export function isCodeMuxDiagnosticEvent(value: unknown): value is CodeMuxDiagnosticEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'diagnostic';
}

export function isCodeMuxUserInputRequestedEvent(value: unknown): value is CodeMuxUserInputRequestedEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'user_input_requested';
}

export function isCodeMuxPermissionRequestedEvent(value: unknown): value is CodeMuxPermissionRequestedEvent {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'permission_requested';
}

export function isCodeMuxTurnEvent(value: unknown): value is CodeMuxTurnEvent {
  return Boolean(value) && typeof value === 'object' && ['error', 'turn_finished'].includes((value as { type?: unknown }).type as string);
}
