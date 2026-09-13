"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type ContextDisplayProps = {
  usedTokens: number;
  totalTokens: number;
  modelName?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

export function ContextDisplay({
  usedTokens,
  totalTokens,
  modelName: _modelName,
  inputTokens,
  cachedTokens,
  outputTokens,
  reasoningTokens,
}: ContextDisplayProps) {
  if (totalTokens <= 0) {
    return null;
  }

  const percentage = Math.min((usedTokens / totalTokens) * 100, 100);
  const percentageLabel = `${Math.round(percentage)}%`;

  const rows = [
    { label: '输入', value: inputTokens },
    { label: '缓存输入', value: cachedTokens },
    { label: '输出', value: outputTokens },
    { label: '思考', value: reasoningTokens },
  ].filter((row) => typeof row.value === 'number' && row.value > 0);

  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="context-display-trigger"
          className="inline-flex h-8 shrink-0 self-center items-center justify-center rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label="查看上下文使用情况"
        >
          <UsageRing percentage={percentage} />
        </button>
      </TooltipTrigger>

      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        data-slot="context-display-popover"
        className="w-64 rounded-xl border border-border p-0 text-popover-foreground shadow-lg !bg-popover !dark:bg-popover"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium text-foreground">上下文</span>
          <span className="text-sm font-medium tabular-nums text-foreground">
            {formatCompactTokens(usedTokens)}/{formatCompactTokens(totalTokens)} ({percentageLabel})
          </span>
        </div>

        <div className="px-4 pb-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(percentage, 0.5)}%`,
                backgroundColor: getProgressColor(percentage),
              }}
            />
          </div>
        </div>

        {rows.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <div className="space-y-2">
              {rows.map((row) => (
                <StatRow key={row.label} label={row.label} value={row.value!} />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-sm font-medium text-foreground">平均缓存命中率</span>
          <span className="text-sm font-medium tabular-nums text-foreground">
            {getCacheHitRate(inputTokens, cachedTokens)}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function UsageRing({ percentage }: { percentage: number }) {
  const size = 24;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const stroke = getProgressColor(percentage);

  return (
    <div className="relative flex h-4 w-4 items-center justify-center">
      <svg className="-rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground/82">{label}</span>
      <span className="font-medium tabular-nums text-foreground">
        {formatCompactTokens(value)}
      </span>
    </div>
  );
}

function getProgressColor(percentage: number) {
  if (percentage >= 85) return 'hsl(var(--destructive))';
  if (percentage >= 65) return 'hsl(var(--warning))';
  return 'hsl(var(--muted-foreground))';
}

function formatCompactTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function getCacheHitRate(inputTokens?: number, cachedTokens?: number): string {
  const input = inputTokens ?? 0;
  const cached = cachedTokens ?? 0;
  const total = input + cached;
  if (total <= 0) return '--';
  const rate = (cached / total) * 100;
  return `${Math.round(rate)}%`;
}
