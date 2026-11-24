import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../stores/agentStore';
import {
  hasToolOnlyAssistantAfterIndex,
  isNarrationContinuationAssistantEvent,
  isNarrationOnlyAssistantEvent,
  isToolOnlyAssistantEvent,
  placeNarrationEvent,
  textFromNarrationOnlyAssistantEvent,
} from './narrationPlacement';

const user = (content: string): AgentMessage => ({ kind: 'user', data: { content } });
const textEvent = (text: string, uuid = `text-${text}`): Extract<AgentMessage, { kind: 'assistant' }> => ({
  kind: 'assistant',
  data: {
    type: 'assistant',
    uuid,
    session_id: 's',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  },
});
const toolEvent = (id: string): Extract<AgentMessage, { kind: 'assistant' }> => ({
  kind: 'assistant',
  data: {
    type: 'assistant',
    uuid: `tool-${id}`,
    session_id: 's',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: {} }] },
    parent_tool_use_id: null,
  },
});
const toolResult = (id: string): AgentMessage => ({
  kind: 'tool_result',
  data: {
    type: 'user',
    uuid: `result-${id}`,
    session_id: 's',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
  },
});

const noLive = () => false;

describe('narrationPlacement predicates', () => {
  it('识别纯文本 / 纯工具 / 思考+正文三种形状', () => {
    expect(isNarrationOnlyAssistantEvent(textEvent('hi'))).toBe(true);
    expect(isNarrationOnlyAssistantEvent(toolEvent('t1'))).toBe(false);

    expect(isToolOnlyAssistantEvent(toolEvent('t1'))).toBe(true);
    expect(isToolOnlyAssistantEvent(textEvent('hi'))).toBe(false);
    expect(isToolOnlyAssistantEvent(undefined)).toBe(false);

    const combined = {
      kind: 'assistant',
      data: {
        type: 'assistant',
        uuid: 'c',
        session_id: 's',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'so' }],
        },
        parent_tool_use_id: null,
      },
    } as Extract<AgentMessage, { kind: 'assistant' }>;
    expect(isNarrationContinuationAssistantEvent(combined)).toBe(true);
    expect(isNarrationOnlyAssistantEvent(combined)).toBe(false);
    expect(textFromNarrationOnlyAssistantEvent(combined)).toBeUndefined();
  });

  it('hasToolOnlyAssistantAfterIndex 遇到真实用户消息即停', () => {
    const events = [toolEvent('t1'), user('next'), toolEvent('t2')];
    expect(hasToolOnlyAssistantAfterIndex(events, 0)).toBe(false);
  });
});

describe('placeNarrationEvent', () => {
  it('Claude 的最终答复：工具已完成 → 追加到末尾，不插到工具之前', () => {
    const events = [user('go'), toolEvent('t1'), toolResult('t1'), toolEvent('t2'), toolResult('t2')];
    const final = textEvent('FINAL');

    const { events: placed, strategy } = placeNarrationEvent(events, final, {
      narrationText: 'FINAL',
      isLiveNarration: noLive,
      allowInsertBeforeTools: false,
    });

    expect(strategy).toBe('append');
    expect(placed[placed.length - 1]).toBe(final);
  });

  it('OpenCode 的晚到叙述：允许插到尾部工具之前（即便工具已完成）', () => {
    const events = [user('go'), toolEvent('t1'), toolResult('t1')];
    const narration = textEvent('先看这个文件：');

    const { events: placed, strategy } = placeNarrationEvent(events, narration, {
      narrationText: '先看这个文件：',
      isLiveNarration: noLive,
      allowInsertBeforeTools: true,
    });

    expect(strategy).toBe('insert-before-tools');
    expect(placed[0]).toBe(events[0]);
    expect(placed[1]).toBe(narration);
    expect(placed[2]).toBe(events[1]);
  });

  it('能原地替换实时叙述时优先替换，位置不变', () => {
    const live: Extract<AgentMessage, { kind: 'assistant' }> = {
      ...textEvent('partial', 'live-stream-narration:s'),
    };
    const events = [user('go'), live, toolEvent('t1'), toolResult('t1')];
    const final = textEvent('partial and more', 'final');

    const { events: placed, strategy } = placeNarrationEvent(events, final, {
      narrationText: 'partial and more',
      isLiveNarration: (candidate) => candidate === live,
      allowInsertBeforeTools: false,
    });

    expect(strategy).toBe('replace-live');
    expect(placed[1]).toBe(final);
    expect(placed).toHaveLength(events.length);
  });

  it('尾部没有工具时一律追加', () => {
    const events = [user('go'), textEvent('earlier')];
    const next = textEvent('later');

    const { events: placed, strategy } = placeNarrationEvent(events, next, {
      narrationText: 'later',
      isLiveNarration: noLive,
      allowInsertBeforeTools: true,
    });

    expect(strategy).toBe('append');
    expect(placed[placed.length - 1]).toBe(next);
  });
});
