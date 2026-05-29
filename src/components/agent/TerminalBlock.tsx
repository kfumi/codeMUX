import { useState } from 'react';
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react';

interface TerminalBlockProps {
  command: string;
  output?: string;
  isRunning?: boolean;
}

export function TerminalBlock({ command, output, isRunning }: TerminalBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-border rounded-lg bg-muted my-2 font-mono text-sm">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-foreground/80 hover:bg-muted/80 transition-colors rounded-t-lg"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Terminal className="h-4 w-4" />
        <span className="truncate">{command}</span>
        {isRunning && <span className="ml-auto text-amber-500 animate-pulse">运行中...</span>}
      </button>
      {isExpanded && output && (
        <div className="px-3 pb-3 text-foreground/70 whitespace-pre-wrap border-t border-border pt-2 max-h-64 overflow-auto">
          {output}
        </div>
      )}
    </div>
  );
}
