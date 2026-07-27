import type { AgentMessage } from '@/stores/agentStore';

type CodeMuxStreamEvent = {
  type: 'content_started' | 'text_delta' | 'reasoning_delta' | 'content_finished';
  session_id?: string;
  index?: number;
  content_kind?: 'text' | 'reasoning';
  text?: string;
  event_id?: string;
};

export function isCodeMuxStreamEvent(value: unknown): value is CodeMuxStreamEvent {
  return Boolean(value)
    && typeof value === 'object'
    && ['content_started', 'text_delta', 'reasoning_delta', 'content_finished'].includes((value as { type?: unknown }).type as string);
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
