import { describe, expect, it } from 'vitest';

import {
  LONG_SESSION_EVENT_THRESHOLD,
  LONG_SESSION_EVENTS_PER_TURN,
  LONG_SESSION_ID,
  LONG_SESSION_TURN_COUNT,
  PROBE_TURN_COUNT,
  buildLongSessionEvents,
  longSessionEventCount,
  userMessageEventIndex,
} from './longSessionFixture';

describe('longSessionFixture', () => {
  it('每轮四条事件，且总数与轮数一致', () => {
    const events = buildLongSessionEvents(12);
    expect(events).toHaveLength(12 * LONG_SESSION_EVENTS_PER_TURN);
    expect(longSessionEventCount(12)).toBe(12 * LONG_SESSION_EVENTS_PER_TURN);
  });

  it('默认规模与探针规模都超过长会话阈值', () => {
    // 阈值以下不会进入任何长会话路径，夹具本身必须先站在阈值之上，否则基准与
    // 探针测的都不是长会话。
    expect(longSessionEventCount()).toBeGreaterThan(LONG_SESSION_EVENT_THRESHOLD);
    expect(longSessionEventCount(PROBE_TURN_COUNT)).toBeGreaterThan(LONG_SESSION_EVENT_THRESHOLD);
  });

  it('用户消息落在 userMessageEventIndex 给出的下标上', () => {
    const events = buildLongSessionEvents(6);
    for (let turn = 0; turn < 6; turn += 1) {
      const index = userMessageEventIndex(turn);
      expect(events[index]?.kind).toBe('user');
    }
  });

  it('工具结果回指的 tool_use 就是同一轮的工具调用', () => {
    const events = buildLongSessionEvents(3);
    const toolUse = events[1];
    const toolResult = events[2];

    expect(toolUse?.kind).toBe('assistant');
    expect(toolResult?.kind).toBe('tool_result');
    if (toolUse?.kind !== 'assistant' || toolResult?.kind !== 'tool_result') {
      throw new Error('夹具形状与预期不符');
    }

    const useId = toolUse.data.message.content[0];
    const resultUseId = toolResult.data.message.content[0];
    expect(useId?.type).toBe('tool_use');
    expect(resultUseId?.type).toBe('tool_result');
    if (useId?.type !== 'tool_use' || resultUseId?.type !== 'tool_result') {
      throw new Error('夹具形状与预期不符');
    }
    expect(resultUseId.tool_use_id).toBe(useId.id);
  });

  it('行高是可变的：工具结果行数与用户文本长度都随轮次变化', () => {
    // 占位高度与真实高度不同才是探针要裁决的误差来源；若所有行等高，
    // 误差会退化成 0，夹具就失去了检验能力。
    const events = buildLongSessionEvents(12);
    const resultLineCounts = events
      .filter((event) => event.kind === 'tool_result')
      .map((event) => (event.kind === 'tool_result' && event.data.message.content[0]?.type === 'tool_result'
        ? event.data.message.content[0].content.split('\n').length
        : 0));
    const userTextLengths = events
      .filter((event) => event.kind === 'user')
      .map((event) => (event.kind === 'user' ? event.data.content.length : 0));

    expect(new Set(resultLineCounts).size).toBeGreaterThan(1);
    expect(new Set(userTextLengths).size).toBeGreaterThan(1);
  });

  it('构造是确定的：同参数两次构建结果一致', () => {
    // 基准的「同一夹具 + 同一种子重放两次读数一致」建立在这条之上。
    expect(buildLongSessionEvents(5)).toEqual(buildLongSessionEvents(5));
  });

  it('会话身份贯穿全部事件', () => {
    const events = buildLongSessionEvents(4);
    const sessionIds = events
      .filter((event) => event.kind === 'assistant' || event.kind === 'tool_result')
      .map((event) => ('session_id' in event.data ? event.data.session_id : undefined));

    expect(new Set(sessionIds)).toEqual(new Set([LONG_SESSION_ID]));
  });

  it('默认轮数与常量自洽', () => {
    expect(buildLongSessionEvents()).toHaveLength(longSessionEventCount(LONG_SESSION_TURN_COUNT));
  });
});
