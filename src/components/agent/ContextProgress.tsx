import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';

interface ContextProgressProps {
  usedTokens: number;
  totalTokens: number;
}

export function ContextProgress({ usedTokens, totalTokens }: ContextProgressProps) {
  if (totalTokens <= 0) return null;

  const pct = Math.min(usedTokens / totalTokens, 1);
  const pctDisplay = (pct * 100).toFixed(1);

  // Color: green < 50%, yellow 50-80%, red > 80%
  const color = pct > 0.8 ? 'text-red-500' : pct > 0.5 ? 'text-yellow-500' : 'text-green-500';

  // SVG circle parameters
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 shrink-0 cursor-default">
          <svg width="18" height="18" viewBox="0 0 18 18" className={color}>
            <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" opacity={0.15} strokeWidth="2" />
            <circle
              cx="9" cy="9" r={r}
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={offset}
              transform="rotate(-90 9 9)"
            />
          </svg>
          <span className="text-[11px] text-muted-foreground/70 tabular-nums leading-none"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {pctDisplay}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {pctDisplay}% · {formatTokens(usedTokens)} / {formatTokens(totalTokens)} 上下文
      </TooltipContent>
    </Tooltip>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
