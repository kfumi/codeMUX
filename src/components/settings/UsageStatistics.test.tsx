// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenBreakdownResponse, UsageStatsResponse } from '../../types/usage';
import { UsageStatistics } from './UsageStatistics';

const { getStatsMock, getTokenBreakdownMock } = vi.hoisted(() => ({
  getStatsMock: vi.fn(),
  getTokenBreakdownMock: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    usage: {
      getStats: getStatsMock,
      getTokenBreakdown: getTokenBreakdownMock,
    },
  },
}));

const statsFixture: UsageStatsResponse = {
  heatmap: [],
  overview: { totalSessions: 3, activeDays: 2 },
  agentDistribution: [
    { agentKind: 'claude_code', count: 2 },
    { agentKind: 'pi', count: 1 },
  ],
  modelDistribution: [{ model: 'glm-5.3-flash', sessionCount: 1 }],
};

const tokenFixture: TokenBreakdownResponse = {
  daily: [{ date: '2026-09-15', inputTokens: 9048, outputTokens: 354, cachedTokens: 8320 }],
  total: {
    inputTokens: 9048,
    outputTokens: 354,
    cachedTokens: 8320,
    totalTokens: 17722,
    cacheRate: 47.9,
  },
  heatmapTokens: [{ date: '2026-09-15', totalTokens: 17722 }],
  modelTokens: [{ model: 'glm-5.3-flash', totalTokens: 17722, sessionCount: 1 }],
  agentTokens: [{ agentKind: 'pi', totalTokens: 17722, sessionCount: 1 }],
};

/** Radix Select 在 jsdom 下用键盘打开（OPEN_KEYS），比 pointer 事件稳定。 */
async function openAgentFilter() {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  return screen.findByRole('listbox');
}

function agentOptionTexts(): string[] {
  return screen
    .getAllByRole('option')
    .map((option) => (option.textContent ?? '').trim().toLowerCase());
}

describe('UsageStatistics', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
    // jsdom 不提供 ResizeObserver，UsageBarChart / UsageHeatmap 需要它。
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    getStatsMock.mockReset();
    getTokenBreakdownMock.mockReset();
    getStatsMock.mockResolvedValue(statsFixture);
    getTokenBreakdownMock.mockResolvedValue(tokenFixture);
  });

  // RTL 在 vitest 非全局模式下不自动 cleanup，重复渲染会让同一文本匹配到多次。
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('筛选列表不再提供 Gemini 选项', async () => {
    render(<UsageStatistics />);

    await openAgentFilter();

    const labels = agentOptionTexts();
    expect(labels.some((label) => label.includes('gemini'))).toBe(false);
  });

  it('筛选列表提供 pi 选项，选中后按 pi 重新拉取统计', async () => {
    render(<UsageStatistics />);

    await waitFor(() => expect(getTokenBreakdownMock).toHaveBeenCalledWith(undefined, 30));

    await openAgentFilter();
    const piOption = screen
      .getAllByRole('option')
      .find((option) => (option.textContent ?? '').toLowerCase().includes('pi'));
    expect(piOption).toBeTruthy();

    // Radix 选项的 pointerType 默认是 touch，jsdom 下 click 即完成选中。
    fireEvent.click(piOption!);

    await waitFor(() => expect(getTokenBreakdownMock).toHaveBeenCalledWith('pi', 30));
    await waitFor(() => expect(getStatsMock).toHaveBeenCalledWith('pi', 30));
  });

  it('智能体分布展示 pi 的 Token 用量占比', async () => {
    render(<UsageStatistics />);

    await waitFor(() => expect(screen.getByText('17.7K · 100.0%')).toBeTruthy());
    // pi 会话只统计一次，不会因为 token 与 session 两个数据源重复成两行。
    expect(screen.getAllByText('pi')).toHaveLength(1);
  });

  it('快速切换时间范围时只请求最终参数', () => {
    vi.useFakeTimers();
    render(<UsageStatistics />);

    fireEvent.click(screen.getByRole('button', { name: '最近 7 天' }));
    fireEvent.click(screen.getByRole('button', { name: '最近 30 天' }));

    act(() => vi.advanceTimersByTime(149));
    expect(getStatsMock).not.toHaveBeenCalled();
    expect(getTokenBreakdownMock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(getStatsMock).toHaveBeenCalledTimes(1);
    expect(getStatsMock).toHaveBeenCalledWith(undefined, 30);
    expect(getTokenBreakdownMock).toHaveBeenCalledTimes(1);
    expect(getTokenBreakdownMock).toHaveBeenCalledWith(undefined, 30);
  });
});
