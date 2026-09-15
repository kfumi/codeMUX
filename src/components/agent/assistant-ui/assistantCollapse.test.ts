import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/stores/agentStore';
import { buildAssistantCollapseInfoMap } from '@/components/agent/assistant-ui/assistantCollapse';

function toolAssistant(id: string, name: string, input: Record<string, unknown> = {}): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'tool_use', id, name, input }],
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

function thinkingAssistant(thinking: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'thinking', thinking }],
      },
    },
  } as unknown as AgentMessage;
}

describe('buildAssistantCollapseInfoMap', () => {
  it('collapses trailing tool steps that appear after the final text assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      textAssistant('final answer'),
      toolAssistant('tool-1', 'bash'),
      toolAssistant('tool-2', 'read'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const collapseInfo = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true });
    const toggleEntries = [...collapseInfo.entries()].filter(([, info]) => info.isToggleMessage);

    expect(toggleEntries).toHaveLength(1);
    expect(collapseInfo.get(2)?.turnKey).toBe(toggleEntries[0]?.[1].turnKey);
    expect(collapseInfo.get(3)?.turnKey).toBe(toggleEntries[0]?.[1].turnKey);
  });

  it('uses the first renderable collapsible event as the toggle anchor', () => {
    const events = [
      { kind: 'user', data: { content: '使用 ask_user_question' } },
      textAssistant('\n\n'),
      toolAssistant('call-1', 'ask_user_question', {
        questions: [{
          question: '你更喜欢哪种编程语言？',
          options: [{ label: 'Python' }],
        }],
      }),
      {
        kind: 'ask_user_question',
        data: {
          tool_use_id: 'call-1',
          questions: [{
            question: '你更喜欢哪种编程语言？',
            options: [{ label: 'Python' }],
          }],
        },
      },
      textAssistant('谢谢你的回答！'),
      { kind: 'result', data: { type: 'result', duration_ms: 36000 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const collapseInfo = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true });
    const toggleEntries = [...collapseInfo.entries()].filter(([, info]) => info.isToggleMessage);

    expect(toggleEntries).toHaveLength(1);
    expect(toggleEntries[0]?.[0]).toBe(2);
    expect(collapseInfo.get(3)?.isToggleMessage).toBe(false);
  });

  it('does not collapse a turn that does not end with summary text', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      textAssistant('intermediate narration'),
      toolAssistant('tool-1', 'bash'),
      thinkingAssistant('trailing reasoning only'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const collapseInfo = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true });

    expect(collapseInfo.size).toBe(0);
  });
});
