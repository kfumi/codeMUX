import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../../stores/agentStore';
import { buildAssistantResultTargetMap, buildAssistantResultTargetSet } from './assistantResultTargets';

describe('assistant result targets', () => {
  it('does not bind a result to a tool-only assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'assistant', data: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] } } },
      { kind: 'tool_result', data: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    expect(buildAssistantResultTargetMap(events)).toEqual(new Map());
    expect(buildAssistantResultTargetSet(events)).toEqual(new Set());
  });

  it('binds a result to a later text assistant in the same turn', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'assistant', data: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] } } },
      { kind: 'tool_result', data: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
      { kind: 'assistant', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    ] as unknown as AgentMessage[];

    expect(buildAssistantResultTargetMap(events)).toEqual(new Map([[4, 3]]));
    expect(buildAssistantResultTargetSet(events)).toEqual(new Set([4]));
  });

  it('rebinds a result past hidden task notifications to the final text assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'assistant', data: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] } } },
      { kind: 'tool_result', data: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
      { kind: 'user', data: { content: '<task-notification>background task finished</task-notification>' } },
      { kind: 'assistant', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    ] as unknown as AgentMessage[];

    expect(buildAssistantResultTargetMap(events)).toEqual(new Map([[5, 3]]));
    expect(buildAssistantResultTargetSet(events)).toEqual(new Set([5]));
  });

  it('rebinds a result past hidden compact transcript-only users to the final text assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'assistant', data: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }] } } },
      { kind: 'tool_result', data: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
      {
        kind: 'user',
        data: {
          content: 'This session is being continued from a previous conversation that ran out of context.',
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        },
      },
      { kind: 'assistant', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    ] as unknown as AgentMessage[];

    expect(buildAssistantResultTargetMap(events)).toEqual(new Map([[5, 3]]));
    expect(buildAssistantResultTargetSet(events)).toEqual(new Set([5]));
  });
});
