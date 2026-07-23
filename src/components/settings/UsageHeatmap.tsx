import { useMemo } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { UsageHeatmapDay } from '../../types/usage';

interface UsageHeatmapProps {
  data: UsageHeatmapDay[];
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

function getLevel(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function formatDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface HeatmapCell {
  dateStr: string;
  count: number;
  isFuture: boolean;
}

interface MonthLabel {
  weekIndex: number;
  label: string;
}

export function UsageHeatmap({ data }: UsageHeatmapProps) {
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
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        暂无活跃数据
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col">
          <div className="mb-[3px] flex h-4 gap-[2px] pl-[35px]">
            {weeks.map((_, wi) => {
              const label = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="w-[11px] overflow-visible whitespace-nowrap text-[10px] leading-4 text-muted-foreground"
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
                  className="h-[11px] text-[10px] leading-[11px] text-muted-foreground"
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
                            'h-[11px] w-[11px] rounded-[2px]',
                            cell.isFuture
                              ? 'bg-transparent'
                              : LEVEL_BG[getLevel(cell.count)],
                          )}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        {cell.isFuture
                          ? cell.dateStr
                          : `${cell.dateStr}: ${cell.count} 个会话`}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className={cn('h-[11px] w-[11px] rounded-[2px]', LEVEL_BG[level])}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
