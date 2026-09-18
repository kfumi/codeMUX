import { describe, expect, it } from 'vitest';

import {
  THREAD_WINDOW_GROWTH_STEP_TURNS,
  THREAD_WINDOW_INITIAL_COMMIT_TURNS,
  THREAD_WINDOW_STEADY_TURNS,
  findTurnIndexByEventIndex,
  growThreadWindow,
  reduceThreadWindow,
  resolveMountedTurnStartEventIndex,
  revealThreadWindow,
  shouldRenderFirstFrameSpacer,
} from './threadWindow';

/** 一个最小轮形状：起始事件下标 + 事件数（本模型的切片点只需要这两样）。 */
function turn(startEventIndex: number, eventCount = 1): { eventIndices: number[] } {
  return {
    eventIndices: Array.from({ length: eventCount }, (_, offset) => startEventIndex + offset),
  };
}

/** 造 n 个连续轮：每轮 4 条事件（与长会话夹具同形）。 */
function turns(count: number, eventsPerTurn = 4): Array<{ eventIndices: number[] }> {
  return Array.from({ length: count }, (_, index) => turn(index * eventsPerTurn, eventsPerTurn));
}

describe('reduceThreadWindow', () => {
  it('0 轮：什么都不挂载、没有隐藏、也无界可言', () => {
    expect(reduceThreadWindow({ totalTurns: 0, windowSize: 0, initialCommit: true }))
      .toEqual({ mountedTurns: 0, hiddenAboveTurns: 0, bounded: false });
    expect(reduceThreadWindow({ totalTurns: 0, windowSize: 500, initialCommit: false }))
      .toEqual({ mountedTurns: 0, hiddenAboveTurns: 0, bounded: false });
  });

  it('首帧提交按首帧常量解析（稳态扩张发生在首帧之后）', () => {
    // 首帧：就算 store 里已有预算（不应发生），首帧门控也只挂首帧常量那么多。
    expect(reduceThreadWindow({ totalTurns: 200, windowSize: 120, initialCommit: true }))
      .toEqual({ mountedTurns: THREAD_WINDOW_INITIAL_COMMIT_TURNS, hiddenAboveTurns: 200 - THREAD_WINDOW_INITIAL_COMMIT_TURNS, bounded: true });
  });

  it('恰好等于稳态：全部挂载、无隐藏、无界', () => {
    expect(reduceThreadWindow({ totalTurns: THREAD_WINDOW_STEADY_TURNS, windowSize: THREAD_WINDOW_STEADY_TURNS, initialCommit: false }))
      .toEqual({ mountedTurns: THREAD_WINDOW_STEADY_TURNS, hiddenAboveTurns: 0, bounded: false });
  });

  it('超过稳态：挂稳态、隐藏其余', () => {
    expect(reduceThreadWindow({ totalTurns: THREAD_WINDOW_STEADY_TURNS + 50, windowSize: THREAD_WINDOW_STEADY_TURNS, initialCommit: false }))
      .toEqual({ mountedTurns: THREAD_WINDOW_STEADY_TURNS, hiddenAboveTurns: 50, bounded: true });
  });

  it('低于稳态但超过首帧：首帧时有界，稳态预算下全部挂载', () => {
    const totalTurns = THREAD_WINDOW_INITIAL_COMMIT_TURNS + 7;
    expect(reduceThreadWindow({ totalTurns, windowSize: 0, initialCommit: true }).bounded).toBe(true);
    expect(reduceThreadWindow({ totalTurns, windowSize: THREAD_WINDOW_STEADY_TURNS, initialCommit: false }))
      .toEqual({ mountedTurns: totalTurns, hiddenAboveTurns: 0, bounded: false });
  });

  it('夹取：上一会话增长出来的预算不会漏进新会话的首帧', () => {
    // 预算 200 > 实际 12 轮：挂 12，不挂 200，也不把「有界」误报出来。
    expect(reduceThreadWindow({ totalTurns: 12, windowSize: 200, initialCommit: false }))
      .toEqual({ mountedTurns: 12, hiddenAboveTurns: 0, bounded: false });
  });
});

describe('growThreadWindow', () => {
  it('从首帧预算增长：第一步直接到稳态', () => {
    expect(growThreadWindow(THREAD_WINDOW_INITIAL_COMMIT_TURNS, 200))
      .toBe(THREAD_WINDOW_STEADY_TURNS);
  });

  it('稳态之后按步长增长', () => {
    expect(growThreadWindow(THREAD_WINDOW_STEADY_TURNS, 200))
      .toBe(THREAD_WINDOW_STEADY_TURNS + THREAD_WINDOW_GROWTH_STEP_TURNS);
    expect(growThreadWindow(THREAD_WINDOW_STEADY_TURNS + THREAD_WINDOW_GROWTH_STEP_TURNS, 200))
      .toBe(THREAD_WINDOW_STEADY_TURNS + THREAD_WINDOW_GROWTH_STEP_TURNS * 2);
  });

  it('上限：夹取到实际已加载轮数', () => {
    expect(growThreadWindow(THREAD_WINDOW_STEADY_TURNS, 40)).toBe(40);
    // 预算已经超过实际轮数（例如回退之后）：不再变化。
    expect(growThreadWindow(50, 40)).toBe(50);
    expect(growThreadWindow(50, 0)).toBe(50);
  });
});

describe('revealThreadWindow', () => {
  it('一步算出包含目标轮所需的预算', () => {
    // 60 轮里要看到第 0 轮：必须全覆盖。
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, 0, 60)).toBe(60);
    // 要看到第 45 轮：挂尾部 15 轮即可，但预算只增不减。
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, 45, 60)).toBe(THREAD_WINDOW_STEADY_TURNS);
  });

  it('目标已在窗口内时预算不变', () => {
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, 59, 60)).toBe(THREAD_WINDOW_STEADY_TURNS);
  });

  it('越界与空历史：按夹取语义处理，预算不无谓扩张', () => {
    // 越界下标按「最后一轮」夹取（与 findTurnIndexByEventIndex 一致），预算不扩张。
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, 999, 60)).toBe(THREAD_WINDOW_STEADY_TURNS);
    // 负数下标按「第一轮」夹取：要看第 0 轮就必须全覆盖。
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, -3, 60)).toBe(60);
    expect(revealThreadWindow(THREAD_WINDOW_STEADY_TURNS, 0, 0)).toBe(THREAD_WINDOW_STEADY_TURNS);
  });
});

describe('shouldRenderFirstFrameSpacer', () => {
  it('只在首帧有界提交时存在', () => {
    expect(shouldRenderFirstFrameSpacer({ bounded: true, windowSize: 0 })).toBe(true);
    expect(shouldRenderFirstFrameSpacer({ bounded: true, windowSize: THREAD_WINDOW_INITIAL_COMMIT_TURNS })).toBe(true);
    // 稳态或增长之后：真实行已经在上方，占位必须退场。
    expect(shouldRenderFirstFrameSpacer({ bounded: true, windowSize: THREAD_WINDOW_STEADY_TURNS })).toBe(false);
    // 没有被扣掉的历史时从不挂占位。
    expect(shouldRenderFirstFrameSpacer({ bounded: false, windowSize: 0 })).toBe(false);
  });
});

describe('resolveMountedTurnStartEventIndex / findTurnIndexByEventIndex', () => {
  it('切片点 = 尾部窗口里第一个轮的起始事件下标', () => {
    const fixture = turns(10); // 每轮 4 条事件
    expect(resolveMountedTurnStartEventIndex(fixture, 10)).toBe(0);
    expect(resolveMountedTurnStartEventIndex(fixture, 3)).toBe(7 * 4);
    expect(resolveMountedTurnStartEventIndex([], 3)).toBe(0);
  });

  it('按事件下标找归属轮：落在某轮区间内即归属该轮', () => {
    const fixture = turns(5);
    expect(findTurnIndexByEventIndex(fixture, 0)).toBe(0);
    expect(findTurnIndexByEventIndex(fixture, 6)).toBe(1);
    expect(findTurnIndexByEventIndex(fixture, 19)).toBe(4);
    // 越界下标（事件还没到）：归到最后一轮，让「揭示」至少把窗口开到全覆盖。
    expect(findTurnIndexByEventIndex(fixture, 999)).toBe(4);
    expect(findTurnIndexByEventIndex([], 3)).toBe(0);
  });
});
