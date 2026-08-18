import { ChevronDown, ChevronRight } from 'lucide-react';

import { formatElapsed } from '../../lib/turnDuration';

interface CompactProcessToggleProps {
  expanded: boolean;
  durationMs?: number;
  onToggle: () => void;
}

export function CompactProcessToggle({ expanded, durationMs, onToggle }: CompactProcessToggleProps) {
  return (
    <div className={expanded ? 'pb-2' : 'pb-1'}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 pl-1 text-sm font-medium text-muted-foreground/80 transition-colors hover:text-muted-foreground"
        aria-expanded={expanded}
        aria-label={expanded ? '收起 AI 过程' : '展开 AI 过程'}
        onClick={onToggle}
      >
        <span>已处理</span>
        {durationMs != null ? <span className="tabular-nums">{formatElapsed(durationMs)}</span> : null}
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {expanded ? <div className="mt-1.5 border-b border-border/40" /> : null}
    </div>
  );
}
