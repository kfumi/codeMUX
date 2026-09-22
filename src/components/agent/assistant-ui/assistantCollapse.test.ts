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

/**
 * 工具结果的真实落地形态：独立的 `tool_result` 事件（`data.message.content[].tool_result`）。
 * `agentEventParsing` 把带结果的 user 消息解析成它，主线程事件流里就是这种。
 */
function toolResultEvent(toolUseId: string, result: Record<string, unknown> = {}): AgentMessage {
  return {
    kind: 'tool_result',
    data: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'result', ...result }],
      },
    },
  } as unknown as AgentMessage;
}

/** 另一条落地形态：只含结果的 user 消息（Companion 协议给浏览器/配对客户端的那份投影）。 */
function toolResultUser(toolUseId: string, isError = false): AgentMessage {
  return {
    kind: 'user',
    data: {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: 'result', is_error: isError },
        ],
      },
    },
  } as unknown as AgentMessage;
}

/** 一个事件里既有文本又有工具调用：文本是说明，不算步骤。 */
function textAndToolAssistant(text: string, id: string, name = 'bash'): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [
          { type: 'text', text },
          { type: 'tool_use', id, name, input: {} },
        ],
      },
    },
  } as unknown as AgentMessage;
}

describe('buildAssistantCollapseInfoMap 的步骤数与异常标记', () => {
  it('数出思考与工具步骤，文本片段不算步骤', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      thinkingAssistant('先看一遍代码'),
      textAndToolAssistant('我先把文件读出来', 'tool-1'),
      toolResultEvent('tool-1'),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.stepCount).toBe(2);
    expect(info?.hasError).toBe(false);
  });

  it('本轮工具拿到 is_error 结果时标记异常', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      toolResultEvent('tool-1', { is_error: true }),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.hasError).toBe(true);
  });

  it('error 事件折进工具卡：标记异常但不额外算一步', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      { kind: 'error', data: { error: 'boom' } },
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.hasError).toBe(true);
    expect(info?.stepCount).toBe(1);
  });

  it('上一轮工具的失败不算到这一轮头上', () => {
    const events = [
      { kind: 'user', data: { content: 'first' } },
      toolAssistant('tool-old', 'bash'),
      toolResultEvent('tool-old', { is_error: true }),
      textAssistant('first answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
      { kind: 'user', data: { content: 'second' } },
      toolAssistant('tool-new', 'bash'),
      toolResultEvent('tool-new'),
      textAssistant('second answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const map = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true });

    expect(map.get(1)?.hasError).toBe(true);
    expect(map.get(6)?.hasError).toBe(false);
  });
});

describe('buildAssistantCollapseInfoMap 的步骤数口径', () => {
  it('连续的重试事件在转换层被并成一行，只算一步', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'api_retry', data: { attempt: 1 } },
      { kind: 'api_retry', data: { attempt: 2 } },
      { kind: 'api_retry', data: { attempt: 3 } },
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.stepCount).toBe(1);
  });

  it('助手已经发过问询工具调用时，问询事件不重复算一步', () => {
    const events = [
      { kind: 'user', data: { content: '使用 ask_user_question' } },
      toolAssistant('call-1', 'ask_user_question', { questions: [] }),
      { kind: 'ask_user_question', data: { tool_use_id: 'call-1', questions: [] } },
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.stepCount).toBe(1);
  });

  it('结果内容里只有 exit_code 非 0 时也算异常（与工具卡同一判据）', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      toolResultEvent('tool-1', { content: JSON.stringify({ exit_code: 1, stdout: '' }) }),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.hasError).toBe(true);
  });

  it('只含结果的 user 消息投影里的失败同样标记异常', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      toolResultUser('tool-1', true),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.hasError).toBe(true);
  });

  it('没有待结果工具时，error 事件自己画一行并算一步', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      { kind: 'error', data: { error: 'provider hiccup' } },
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    expect(info?.stepCount).toBe(1);
    expect(info?.hasError).toBe(true);
  });

  it('同一个 tool_use_id 的重复投影（输入刷新）只算一步', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('call-1', 'read', {}),
      toolAssistant('call-1', 'read', { filePath: 'D:/demo/package.json' }),
      toolAssistant('call-2', 'bash', { command: 'pwd' }),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];
    const timestamps = events.map((_, index) => index * 1000);

    const info = buildAssistantCollapseInfoMap(events, timestamps, { allowImplicitResult: true }).get(1);

    // 渲染层把第二帧当成第一张卡的参数刷新（不再多画一行），标题数字也只能算两步。
    expect(info?.stepCount).toBe(2);
  });
});
