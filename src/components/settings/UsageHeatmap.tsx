import { useMemo } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { UsageHeatmapDay } from '../../types/usage';

export function UsageHeatmapLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
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

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        暂无活跃数据
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex justify-center overflow-x-auto">
        <div className="inline-flex flex-col">
          <div className="mb-[3px] flex h-4 gap-[2px] pl-[35px]">
            {weeks.map((_, wi) => {
              const label = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="w-[13px] overflow-visible whitespace-nowrap text-[10px] leading-4 text-muted-foreground"
                >
                  {label?.label ?? ''}
                </div>
              );
            })}
          </div>

          <div className="flex gap-[3px]">
            <div className="flex w-8 flex-col gap-[2px]">
              {DAY_LABELS.map((label, i) => (
                <div
                  key={label}
                  className="h-[13px] text-[10px] leading-[13px] text-muted-foreground"
                >
                  {i % 2 === 1 ? label : ''}
                </div>
              ))}
            </div>

            <div className="flex gap-[2px]">
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[2px]">
                  {week.map((cell) => (
                    <Tooltip key={cell.dateStr} delayDuration={250}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            'h-[13px] w-[13px] rounded-[2px]',
                            cell.isFuture
                              ? 'bg-transparent'
                              : LEVEL_BG[getLevel(cell.tokens)],
                          )}
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
