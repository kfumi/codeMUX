// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildTokenThresholds } from '../../lib/usageHeatmapScale';
import type { UsageHeatmapDay } from '../../types/usage';
import { TooltipProvider } from '../ui/tooltip';
import { UsageHeatmap } from './UsageHeatmap';

/** 与组件相同的本地日期字符串，取「N 天前」。 */
function localDateString(daysAgo: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 已渲染格子的颜色类（排除未来日期的透明格子）。 */
function renderedCellClasses(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div.rounded-\\[2px\\]'))
    .map((cell) => cell.className)
    .filter((className) => !className.includes('bg-transparent'));
}

function renderHeatmap(data: UsageHeatmapDay[], tokenMap?: Map<string, number>) {
  return render(
    <TooltipProvider>
      <UsageHeatmap
        data={data}
        tokenMap={tokenMap}
        tokenThresholds={buildTokenThresholds([...(tokenMap?.values() ?? [])])}
      />
    </TooltipProvider>,
  );
}

describe('UsageHeatmap', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('日消耗量级差异很大时仍能分出多档颜色', () => {
    // 5M~150M 的日消耗：旧固定阈值 50K/200K/500K 会把这几天全部涂成同一个最深色。
    const dailyTokens = [5_000_000, 12_000_000, 20_000_000, 45_000_000, 150_000_000];
    const data: UsageHeatmapDay[] = dailyTokens.map((_, index) => ({
      date: localDateString(index + 1),
      count: 1,
    }));
    const tokenMap = new Map(data.map((day, index) => [day.date, dailyTokens[index]] as const));

    const { container } = renderHeatmap(data, tokenMap);

    // 多档色 + 空档色，说明深浅确实在区分而不是全被顶到最高档。
    expect(new Set(renderedCellClasses(container)).size).toBeGreaterThanOrEqual(4);
  });

  it('没有 Token 数据时不渲染出高消耗档', () => {
    const data: UsageHeatmapDay[] = [{ date: localDateString(1), count: 2 }];

    const { container } = renderHeatmap(data);

    expect(
      renderedCellClasses(container).some((className) => className.includes('bg-primary')),
    ).toBe(false);
  });
});
