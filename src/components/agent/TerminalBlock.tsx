import { useState } from 'react';
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react';

interface TerminalBlockProps {
  command: string;
  output?: string;
  isRunning?: boolean;
}

export function TerminalBlock({ command, output, isRunning }: TerminalBlockProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="border rounded-md bg-black/90 my-2 font-mono text-sm">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-green-400 hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Terminal className="h-4 w-4" />
        <span className="truncate">{command}</span>
        {isRunning && <span className="ml-auto text-yellow-400 animate-pulse">运行中...</span>}
      </button>
      {isExpanded && output && (
        <div className="px-3 pb-3 text-gray-300 whitespace-pre-wrap border-t border-gray-700 pt-2 max-h-64 overflow-auto">
          {output}
        </div>
      )}
    </div>
  );
}
