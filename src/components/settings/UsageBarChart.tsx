import { useLayoutEffect, useRef, useState } from 'react';

import { DailyTokenBreakdown } from '@/types/usage';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface UsageBarChartProps {
  data: DailyTokenBreakdown[];
}

const SEGMENT_COLORS = {
  input: 'hsl(var(--primary))',
  cached: 'hsl(var(--primary) / 0.55)',
  output: 'hsl(142 55% 40%)',
} as const;

const CHART_HEIGHT = 200;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 32;
const PADDING_LEFT = 44;
const PADDING_RIGHT = 10;
const BAR_GAP = 2;
const MIN_BAR_WIDTH = 4;
const MAX_BAR_WIDTH = 24;

function formatFull(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function formatAbbrev(n: number): string {
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

function computeNiceScale(maxValue: number, ticks = 4): { niceMax: number; lines: number[] } {
  if (maxValue <= 0) return { niceMax: 1, lines: [0] };
  const rawStep = maxValue / ticks;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  let niceStep: number;
  if (norm <= 1) niceStep = 1;
  else if (norm <= 2) niceStep = 2;
  else if (norm <= 5) niceStep = 5;
  else niceStep = 10;
  niceStep *= mag;
  const niceMax = Math.ceil(maxValue / niceStep) * niceStep;
  const count = Math.round(niceMax / niceStep);
  const lines: number[] = [];
  for (let i = 0; i <= count; i += 1) lines.push(i * niceStep);
  return { niceMax, lines };
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-popover-foreground/70">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span className="tabular-nums text-popover-foreground">{formatFull(value)}</span>
    </div>
  );
}

export function UsageBarChart({ data }: UsageBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasData =
    data.length > 0 &&
    data.some((d) => d.inputTokens + d.cachedTokens + d.outputTokens > 0);

  const totalHeight = PADDING_TOP + CHART_HEIGHT + PADDING_BOTTOM;

  const chartWidth = Math.max(width - PADDING_LEFT - PADDING_RIGHT, 0);
  const numBars = data.length;
  const totalGap = numBars > 1 ? (numBars - 1) * BAR_GAP : 0;
  const rawBarWidth = numBars > 0 ? (chartWidth - totalGap) / numBars : 0;
  const barWidth = Math.min(Math.max(rawBarWidth, MIN_BAR_WIDTH), MAX_BAR_WIDTH);
  const usedWidth = numBars * barWidth + totalGap;
  const barsOffsetX = PADDING_LEFT + Math.max((chartWidth - usedWidth) / 2, 0);

  const maxValue = data.reduce(
    (m, d) => Math.max(m, d.inputTokens + d.cachedTokens + d.outputTokens),
    0,
  );
  const { niceMax, lines } = computeNiceScale(maxValue || 1);
  const baselineY = PADDING_TOP + CHART_HEIGHT;
  const valueToY = (v: number) =>
    niceMax > 0 ? baselineY - (v / niceMax) * CHART_HEIGHT : baselineY;

  const rotateLabels = numBars >= 7;
  const labelStep = numBars <= 7 ? 1 : Math.max(1, Math.ceil(numBars / 6));

  return (
    <div className="w-full">
      {/* Legend */}
      <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
        <LegendDot color={SEGMENT_COLORS.input} label="输入" />
        <LegendDot color={SEGMENT_COLORS.cached} label="缓存" />
        <LegendDot color={SEGMENT_COLORS.output} label="输出" />
      </div>

      <div ref={containerRef} className="w-full">
        {!hasData ? (
          <div
            className="flex items-center justify-center rounded-lg border border-border/40 bg-muted/20 text-sm text-foreground/40"
            style={{ height: totalHeight }}
          >
            暂无 Token 使用数据
          </div>
        ) : width > 0 ? (
          <TooltipProvider delayDuration={120} skipDelayDuration={150}>
            <svg
              width="100%"
              height={totalHeight}
              viewBox={`0 0 ${width} ${totalHeight}`}
              className="block overflow-visible"
              role="img"
              aria-label="每日 Token 使用量堆叠柱状图"
            >
              {/* Gridlines & Y-axis labels */}
              {lines.map((v) => {
                const y = valueToY(v);
                return (
                  <g key={`grid-${v}`}>
                    <line
                      x1={PADDING_LEFT}
                      y1={y}
                      x2={width - PADDING_RIGHT}
                      y2={y}
                      strokeWidth={1}
                      style={{
                        stroke: 'hsl(var(--border))',
                        strokeOpacity: v === 0 ? 0.6 : 0.22,
                      }}
                    />
                    <text
                      x={PADDING_LEFT - 6}
                      y={y}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize={10}
                      className="fill-muted-foreground"
                    >
                      {formatAbbrev(v)}
                    </text>
                  </g>
                );
              })}

              {/* Stacked bars */}
              {data.map((d, i) => {
                const total = d.inputTokens + d.cachedTokens + d.outputTokens;
                const x = barsOffsetX + i * (barWidth + BAR_GAP);
                const inputH = (d.inputTokens / niceMax) * CHART_HEIGHT;
                const cachedH = (d.cachedTokens / niceMax) * CHART_HEIGHT;
                const outputH = (d.outputTokens / niceMax) * CHART_HEIGHT;
                const inputY = baselineY - inputH;
                const cachedY = inputY - cachedH;
                const outputY = cachedY - outputH;
                const dimmed = hoveredIndex !== null && hoveredIndex !== i;
                return (
                  <g
                    key={d.date}
                    className={cn(
                      'transition-opacity duration-150',
                      dimmed && 'opacity-40',
                    )}
                  >
                    {inputH > 0 && (
                      <rect
                        x={x}
                        y={inputY}
                        width={barWidth}
                        height={inputH}
                        style={{ fill: SEGMENT_COLORS.input }}
                      />
                    )}
                    {cachedH > 0 && (
                      <rect
                        x={x}
                        y={cachedY}
                        width={barWidth}
                        height={cachedH}
                        style={{ fill: SEGMENT_COLORS.cached }}
                      />
                    )}
                    {outputH > 0 && (
                      <rect
                        x={x}
                        y={outputY}
                        width={barWidth}
                        height={outputH}
                        style={{ fill: SEGMENT_COLORS.output }}
                      />
                    )}
                    {total > 0 && (
                      <Tooltip onOpenChange={(open) => setHoveredIndex(open ? i : null)}>
                        <TooltipTrigger asChild>
                          <rect
                            x={x}
                            y={Math.max(outputY, PADDING_TOP)}
                            width={barWidth}
                            height={Math.max(baselineY - Math.max(outputY, PADDING_TOP), 1)}
                            fill="transparent"
                            pointerEvents="all"
                          />
                        </TooltipTrigger>
                        <TooltipContent className="w-48 p-2.5 text-xs">
                          <div className="space-y-1.5">
                            <div className="font-semibold text-popover-foreground">
                              {d.date}
                            </div>
                            <TooltipRow color={SEGMENT_COLORS.input} label="输入" value={d.inputTokens} />
                            <TooltipRow color={SEGMENT_COLORS.output} label="输出" value={d.outputTokens} />
                            <TooltipRow color={SEGMENT_COLORS.cached} label="缓存" value={d.cachedTokens} />
                            <div className="flex items-center justify-between border-t border-border/50 pt-1.5">
                              <span className="text-popover-foreground/60">总计</span>
                              <span className="font-semibold tabular-nums text-popover-foreground">
                                {formatFull(total)}
                              </span>
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </g>
                );
              })}

              {/* X-axis labels */}
              {data.map((d, i) => {
                if (i % labelStep !== 0 && i !== numBars - 1) return null;
                const cx = barsOffsetX + i * (barWidth + BAR_GAP) + barWidth / 2;
                const labelY = baselineY + (rotateLabels ? 12 : 14);
                return (
                  <text
                    key={`label-${d.date}`}
                    x={cx}
                    y={labelY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    className="fill-muted-foreground"
                    transform={rotateLabels ? `rotate(-30 ${cx} ${labelY})` : undefined}
                  >
                    {d.date.slice(5)}
                  </text>
                );
              })}
            </svg>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}
