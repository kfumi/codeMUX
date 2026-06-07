import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';

interface TerminalBlockProps {
  command: string;
  output?: string;
  isRunning?: boolean;
}

export function TerminalBlock({ command, output, isRunning }: TerminalBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border/30 bg-muted/20 my-2 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-foreground/80 hover:bg-muted/30 transition-colors duration-200"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Terminal className="h-3.5 w-3.5 text-[hsl(var(--success)/0.6)] shrink-0" />
        <span className="truncate text-[13px] font-mono text-[hsl(var(--success)/0.8)]">{command}</span>
        {isRunning && <span className="ml-auto text-[11px] text-[hsl(var(--warning))] animate-pulse-soft">运行中...</span>}
      </button>
      {isExpanded && output && (
        <div className="px-3 pb-3 text-foreground/60 whitespace-pre-wrap border-t border-border/20 pt-2.5 max-h-64 overflow-auto text-xs font-mono leading-relaxed animate-fade-in">
          {output}
        </div>
      )}
    </div>
  );
}
