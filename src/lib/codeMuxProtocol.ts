import type { AgentMessage } from '@/stores/agentStore';
import type { AgentAssistantMessage } from '@/types/agent';

type CodeMuxStreamEvent = {
  type: 'content_started' | 'text_delta' | 'reasoning_delta' | 'content_finished';
  session_id?: string;
  index?: number;
  content_kind?: 'text' | 'reasoning';
  text?: string;
  event_id?: string;
};

type CodeMuxToolEvent = {
  type: 'tool_started' | 'tool_finished';
  session_id?: string;
  timestamp?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
  event_id?: string;
};

type CodeMuxAssistantMessageEvent = {
  type: 'assistant_message';
  session_id?: string;
  content?: AgentAssistantMessage['message']['content'];
  event_id?: string;
};

type CodeMuxTurnEvent = {
  type: 'error' | 'turn_finished';
  session_id?: string;
  timestamp?: string;
  subtype?: string;
  error?: string;
  outcome?: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  reason?: string;
  usage?: Record<string, unknown>;
  duration_ms?: number;
  event_id?: string;
};

export function isCodeMuxStreamEvent(value: unknown): value is CodeMuxStreamEvent {
  return Boolean(value)
    && typeof value === 'object'
    && ['content_started', 'text_delta', 'reasoning_delta', 'content_finished'].includes((value as { type?: unknown }).type as string);
}

export function isCodeMuxToolEvent(value: unknown): value is CodeMuxToolEvent {
  return Boolean(value)
    && typeof value === 'object'
    && ['tool_started', 'tool_finished'].includes((value as { type?: unknown }).type as string);
}

export function isCodeMuxAssistantMessageEvent(value: unknown): value is CodeMuxAssistantMessageEvent {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'assistant_message';
}

export function isCodeMuxTurnEvent(value: unknown): value is CodeMuxTurnEvent {
  return Boolean(value)
    && typeof value === 'object'
    && ['error', 'turn_finished'].includes((value as { type?: unknown }).type as string);
}

export function toLegacyStreamingMessage(event: CodeMuxStreamEvent): AgentMessage {
  const index = typeof event.index === 'number' ? event.index : 0;
  if (event.type === 'content_started') {
    return {
      kind: 'streaming',
      data: {
        session_id: event.session_id,
        event: {
          type: 'content_block_start',
          index,
          content_block: { type: event.content_kind === 'reasoning' ? 'thinking' : 'text', ...(event.content_kind === 'reasoning' ? { thinking: '' } : { text: '' }) },
        },
      },
    };
  }
  if (event.type === 'content_finished') {
    return { kind: 'streaming', data: { session_id: event.session_id, event: { type: 'content_block_stop', index } } };
  }
  return {
    kind: 'streaming',
    data: {
      session_id: event.session_id,
      event: {
        type: 'content_block_delta',
        index,
        delta: event.type === 'reasoning_delta' ? { type: 'thinking_delta', thinking: event.text ?? '' } : { type: 'text_delta', text: event.text ?? '' },
      },
    },
  };
}

export function toLegacyToolMessage(event: CodeMuxToolEvent): AgentMessage {
  if (event.type === 'tool_started') {
    return {
      kind: 'assistant',
      data: {
        type: 'assistant',
        uuid: event.event_id ?? crypto.randomUUID(),
        session_id: event.session_id ?? '',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: event.tool_use_id ?? '', name: event.name ?? 'unknown', input: event.input ?? {} }],
        },
        parent_tool_use_id: null,
      },
    };
  }
  return {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: event.event_id ?? crypto.randomUUID(),
      session_id: event.session_id ?? '',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: event.tool_use_id ?? '', content: event.content ?? '', is_error: event.is_error }],
      },
      parent_tool_use_id: null,
    },
  };
}

export function toLegacyAssistantMessage(event: CodeMuxAssistantMessageEvent): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: event.event_id ?? crypto.randomUUID(),
      session_id: event.session_id ?? '',
      message: { role: 'assistant', content: event.content ?? [] },
      parent_tool_use_id: null,
    },
  };
}

export function toLegacyTurnMessage(event: CodeMuxTurnEvent): AgentMessage {
  if (event.type === 'error') {
    return { kind: 'error', data: { type: 'sidecar_error', error: event.error ?? 'CodeMUX runtime error' } };
  }

  const outcome = event.outcome ?? 'failed';
  const isError = outcome !== 'completed';
  const usage = event.usage ?? {};
  return {
    kind: 'result',
    data: {
      type: 'result',
      subtype: outcome === 'completed' ? 'success' : outcome,
      is_error: isError,
      uuid: event.event_id ?? crypto.randomUUID(),
      session_id: event.session_id ?? '',
      duration_ms: event.duration_ms ?? 0,
      duration_api_ms: event.duration_ms ?? 0,
      num_turns: 1,
      result: outcome === 'completed' ? 'ok' : event.reason ?? outcome,
      usage: {
        input_tokens: numberValue(usage.input_tokens),
        output_tokens: numberValue(usage.output_tokens),
        ...(usage.cached_input_tokens !== undefined ? { cache_read_input_tokens: numberValue(usage.cached_input_tokens) } : {}),
      },
      last_token_usage: {
        input_tokens: numberValue(usage.input_tokens),
        output_tokens: numberValue(usage.output_tokens),
        cached_input_tokens: numberValue(usage.cached_input_tokens),
        total_tokens: numberValue(usage.input_tokens) + numberValue(usage.output_tokens),
      },
    },
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
