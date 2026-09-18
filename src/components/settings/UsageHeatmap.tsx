import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipHint, TooltipTrigger } from '../ui/tooltip';
import type { UsageHeatmapDay } from '../../types/usage';
import { buildTokenThresholds, tokenLevel } from '../../lib/usageHeatmapScale';

const DAY_LABEL_WIDTH = 32;
const OUTER_GAP = 3;
const CELL_GAP = 2;
const MAX_CELL_SIZE = 13;
const MIN_CELL_SIZE = 4;
const DEFAULT_CELL_SIZE = 13;
/** 低于该尺寸的格子看不清,窄屏改为横向滚动而不是继续压缩。 */
const READABLE_CELL_SIZE = 9;
/** 月份标签的最小间距(px):靠得太近就跳过,避免窄屏互相重叠。 */
const MIN_MONTH_LABEL_GAP = 30;

/** 图例各档的区间文案；跨度由窗口内活跃日的分位数得出，随数据变化。 */
function buildLevelRanges(thresholds: number[] | null | undefined): string[] {
  if (!thresholds || thresholds.length < 3) {
    return ['无 Token 消耗', '低消耗档', '中低消耗档', '中高消耗档', '高消耗档'];
  }
  const [b1, b2, b3] = thresholds;
  return [
    '无 Token 消耗',
    `少于 ${formatTokenCount(b1)} tokens`,
    `${formatTokenCount(b1)} ~ ${formatTokenCount(b2)} tokens`,
    `${formatTokenCount(b2)} ~ ${formatTokenCount(b3)} tokens`,
    `多于 ${formatTokenCount(b3)} tokens`,
  ];
}

interface UsageHeatmapLegendProps {
  /** 与热力图共用同一份分档阈值，保证图例跨度与格子颜色对得上。 */
  thresholds?: number[] | null;
}

export function UsageHeatmapLegend({ thresholds }: UsageHeatmapLegendProps) {
  const ranges = buildLevelRanges(thresholds);
  return (
    <div className="flex items-center gap-1.5 text-ui-micro text-muted-foreground">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <TooltipHint key={level} content={ranges[level]}>
          <div className={cn('h-[13px] w-[13px] rounded-[2px]', LEVEL_BG[level])} />
        </TooltipHint>
      ))}
      <span>多</span>
    </div>
  );
}

interface UsageHeatmapProps {
  data: UsageHeatmapDay[];
  tokenMap?: Map<string, number>;
  /** 分档阈值；不传时按 tokenMap 自行推导。 */
  tokenThresholds?: number[] | null;
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

export function UsageHeatmap({ data, tokenMap, tokenThresholds }: UsageHeatmapProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  // 分档阈值默认按窗口内「有消耗的日」推导；父组件传入同一份，图例才能显示跨度。
  const thresholds = useMemo(
    () => tokenThresholds ?? buildTokenThresholds(weeks.flat().map((cell) => cell.tokens)),
    [tokenThresholds, weeks],
  );

  /**
   * 宽度用 callback ref + ResizeObserver 测:早先的 useLayoutEffect 在「先渲染空态、
   * 再渲染数据」的时序里拿到的是 null ref,自适应尺寸从来没生效过。
   */
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const attachContainer = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node) return;

    const update = () => setContainerWidth(node.getBoundingClientRect().width);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  // 窄屏:格子被压到看不清时改为固定可读尺寸 + 横向滚动。
  // 派生值必须算在空数据提前返回之前,否则下面的 effect 会读到未初始化的绑定。
  const fittedCellSize = fitCellSize(containerWidth, weeks.length);
  const needsScroll = containerWidth > 0 && fittedCellSize < READABLE_CELL_SIZE;
  const cellSize = needsScroll ? READABLE_CELL_SIZE : fittedCellSize;

  // 横向滚动时默认停在最近几周:手机用户最关心的是当前活跃度。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !needsScroll) return;
    node.scrollLeft = node.scrollWidth;
  }, [needsScroll]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        暂无活跃数据
      </div>
    );
  }

  const weekPitch = cellSize + CELL_GAP;
  const gridWidth =
    DAY_LABEL_WIDTH + OUTER_GAP + weeks.length * cellSize + Math.max(weeks.length - 1, 0) * CELL_GAP;

  // 月份标签按实际列宽去重叠:间距不足就跳过该月,避免糊成一团。
  const visibleMonthWeeks = new Set<number>();
  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (const monthLabel of monthLabels) {
    const x = monthLabel.weekIndex * weekPitch;
    if (x - lastLabelX >= MIN_MONTH_LABEL_GAP) {
      visibleMonthWeeks.add(monthLabel.weekIndex);
      lastLabelX = x;
    }
  }

  const monthLabelPad = DAY_LABEL_WIDTH + OUTER_GAP;
  const cellStyle = { width: cellSize, height: cellSize };

  return (
    <div
      ref={attachContainer}
      className={cn('w-full', needsScroll ? 'overflow-x-auto pb-1' : 'overflow-hidden')}
    >
      <div className={cn('flex', needsScroll ? 'w-max' : 'justify-center')}>
        <div
          className="inline-flex flex-col"
          style={needsScroll ? { width: gridWidth } : undefined}
        >
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
                  {label && visibleMonthWeeks.has(wi) ? label.label : ''}
                </div>
              );
            })}
          </div>

          <div className="flex" style={{ gap: OUTER_GAP }}>
            <div
              className={cn(
                'flex flex-col',
                // 横向滚动时把星期标签钉在左侧,滚动后仍知道每行是周几。
                needsScroll && 'sticky left-0 z-10 bg-[hsl(var(--background))]',
              )}
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
                              : LEVEL_BG[tokenLevel(cell.tokens, thresholds)],
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
