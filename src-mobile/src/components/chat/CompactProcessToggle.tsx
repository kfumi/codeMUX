import { ChevronDown, ChevronRight } from 'lucide-react';

interface CompactProcessToggleProps {
  expanded: boolean;
  onToggle: () => void;
}

export function CompactProcessToggle({ expanded, onToggle }: CompactProcessToggleProps) {
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
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {expanded ? <div className="mt-1.5 border-b border-border/40" /> : null}
    </div>
  );
}
