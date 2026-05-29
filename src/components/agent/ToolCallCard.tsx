import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
}

function getToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.file_path || '');
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    case 'Bash':
      return String(input.command || '');
    case 'WebSearch':
      return String(input.query || '');
    case 'WebFetch':
      return String(input.url || '');
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

export function ToolCallCard({ toolName, input, result, status }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = getToolSummary(toolName, input);

  const statusColors = {
    pending: 'text-muted-foreground',
    running: 'text-yellow-500 animate-pulse',
    done: 'text-green-500',
    error: 'text-red-500',
  };

  return (
    <div className="border rounded-md my-2 bg-muted/20">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">{toolName}</span>
        <span className="text-muted-foreground truncate flex-1 text-left">{summary}</span>
        {status && <span className={`text-xs ${statusColors[status]}`}>{status}</span>}
      </button>
      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1">参数</div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">结果</div>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
