"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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
    { label: '缓存', value: cachedTokens },
    { label: '输出', value: outputTokens },
    { label: '思考', value: reasoningTokens },
  ].filter((row) => typeof row.value === 'number' && row.value > 0);

  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 shrink-0 self-center items-center gap-2 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label="查看上下文使用情况"
        >
          <UsageRing percentage={percentage} />
          <span
            className="text-[12px] font-medium leading-none text-muted-foreground"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {percentageLabel}
          </span>
        </button>
      </TooltipTrigger>

      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-56 rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-lg"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium text-foreground">上下文</span>
          <span
            className="text-sm font-medium text-foreground"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {percentageLabel}
          </span>
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="space-y-2">
            {rows.map((row) => (
              <StatRow key={row.label} label={row.label} value={row.value!} />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-sm font-medium text-foreground">总计</span>
          <span
            className="text-sm font-medium text-foreground"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatCompactTokens(usedTokens)} / {formatCompactTokens(totalTokens)}
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
    <div className="relative flex h-5 w-5 items-center justify-center">
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
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn('font-medium text-foreground')}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {formatCompactTokens(value)}
      </span>
    </div>
  );
}

function getProgressColor(percentage: number) {
  if (percentage >= 90) return 'hsl(var(--destructive))';
  if (percentage >= 70) return 'hsl(var(--warning))';
  return 'hsl(var(--success))';
}

function formatCompactTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}
