import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { UsageHeatmapDay } from '../../types/usage';

const DAY_LABEL_WIDTH = 32;
const OUTER_GAP = 3;
const CELL_GAP = 2;
const MAX_CELL_SIZE = 13;
const MIN_CELL_SIZE = 4;
const DEFAULT_CELL_SIZE = 13;

export function UsageHeatmapLegend() {
  return (
    <div className="flex items-center gap-1.5 text-ui-micro text-muted-foreground">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <div
          key={level}
          className={cn('h-[13px] w-[13px] rounded-[2px]', LEVEL_BG[level])}
        />
      ))}
      <span>多</span>
    </div>
  );
}

interface UsageHeatmapProps {
  data: UsageHeatmapDay[];
  tokenMap?: Map<string, number>;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const LEVEL_BG: Record<number, string> = {
  0: 'bg-muted/40',
  1: 'bg-primary/25',
  2: 'bg-primary/45',
  3: 'bg-primary/70',
  4: 'bg-primary/90',
};

function getLevel(tokens: number): number {
  if (tokens <= 0) return 0;
  if (tokens < 50_000) return 1;
  if (tokens < 200_000) return 2;
  if (tokens < 500_000) return 3;
  return 4;
}

function formatDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(n);
}

function fitCellSize(containerWidth: number, weekCount: number): number {
  if (containerWidth <= 0 || weekCount <= 0) {
    return DEFAULT_CELL_SIZE;
  }
  const available = containerWidth - DAY_LABEL_WIDTH - OUTER_GAP;
  const gaps = Math.max(weekCount - 1, 0) * CELL_GAP;
  const raw = Math.floor((available - gaps) / weekCount);
  return Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, raw));
}

interface HeatmapCell {
  dateStr: string;
  count: number;
  tokens: number;
  isFuture: boolean;
}

interface MonthLabel {
  weekIndex: number;
  label: string;
}

export function UsageHeatmap({ data, tokenMap }: UsageHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(DEFAULT_CELL_SIZE);

  const { weeks, monthLabels } = useMemo<{
    weeks: HeatmapCell[][];
    monthLabels: MonthLabel[];
  }>(() => {
    const countMap = new Map<string, number>();
    for (const day of data) {
      countMap.set(day.date, day.count);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setDate(start.getDate() - 365);

    const gridStart = new Date(start);
    gridStart.setDate(gridStart.getDate() - start.getDay());

    const weeks: HeatmapCell[][] = [];
    const monthLabels: MonthLabel[] = [];
    let lastMonth = -1;
    const cursor = new Date(gridStart);

    while (true) {
      const week: HeatmapCell[] = [];
      for (let d = 0; d < 7; d++) {
        const cellDate = new Date(cursor);
        const dateStr = formatDateString(cellDate);
        const isFuture = cellDate > today;
        week.push({
          dateStr,
          count: isFuture ? 0 : (countMap.get(dateStr) ?? 0),
          tokens: isFuture ? 0 : (tokenMap?.get(dateStr) ?? 0),
          isFuture,
        });
        if (d === 0) {
          const month = cellDate.getMonth();
          if (month !== lastMonth) {
            monthLabels.push({ weekIndex: weeks.length, label: MONTH_LABELS[month] });
            lastMonth = month;
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
      if (cursor > today) break;
    }

    return { weeks, monthLabels };
  }, [data, tokenMap]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      setCellSize(fitCellSize(el.getBoundingClientRect().width, weeks.length));
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        暂无活跃数据
      </div>
    );
  }

  const monthLabelPad = DAY_LABEL_WIDTH + OUTER_GAP;
  const cellStyle = { width: cellSize, height: cellSize };

  return (
    <div ref={containerRef} className="w-full overflow-hidden">
      <div className="flex justify-center">
        <div className="inline-flex max-w-full flex-col">
          <div
            className="mb-[3px] flex h-4"
            style={{ gap: CELL_GAP, paddingLeft: monthLabelPad }}
          >
            {weeks.map((_, wi) => {
              const label = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="overflow-visible whitespace-nowrap text-ui-micro leading-4 text-muted-foreground"
                  style={{ width: cellSize }}
                >
                  {label?.label ?? ''}
                </div>
              );
            })}
          </div>

          <div className="flex" style={{ gap: OUTER_GAP }}>
            <div
              className="flex flex-col"
              style={{ width: DAY_LABEL_WIDTH, gap: CELL_GAP }}
            >
              {DAY_LABELS.map((label, i) => (
                <div
                  key={label}
                  className="text-ui-micro text-muted-foreground"
                  style={{ height: cellSize, lineHeight: `${cellSize}px` }}
                >
                  {i % 2 === 1 ? label : ''}
                </div>
              ))}
            </div>

            <div className="flex" style={{ gap: CELL_GAP }}>
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col" style={{ gap: CELL_GAP }}>
                  {week.map((cell) => (
                    <Tooltip key={cell.dateStr} delayDuration={250}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            'rounded-[2px]',
                            cell.isFuture
                              ? 'bg-transparent'
                              : LEVEL_BG[getLevel(cell.tokens)],
                          )}
                          style={cellStyle}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        {cell.isFuture
                          ? cell.dateStr
                          : `${cell.dateStr}: ${cell.count} 个会话 · ${formatTokenCount(cell.tokens)} tokens`}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
