import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/stores/agentStore';
import { normalizeTurnProcessEventOrder } from '@/lib/agentTurnOrdering';

function toolAssistant(id: string, name: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'tool_use', id, name, input: {} }],
      },
    },
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as AgentMessage;
}

describe('normalizeTurnProcessEventOrder', () => {
  it('moves trailing tool steps before the final text assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      textAssistant('final answer'),
      toolAssistant('tool-1', 'bash'),
      toolAssistant('tool-2', 'read'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    expect(normalizeTurnProcessEventOrder(events).map((event) => event.kind)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
      'result',
    ]);
  });

  it('leaves already-correct turns unchanged', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    expect(normalizeTurnProcessEventOrder(events)).toEqual(events);
  });
});
