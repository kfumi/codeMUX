import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
  durationMs?: number;
  onFileClick?: (path: string, originalContent?: string) => void;
}

interface ToolSummaryPart {
  type: 'text' | 'file-link';
  content: string;
  filePath?: string;
  originalContent?: string;
}

/** Normalize double backslashes to single */
function normalizePath(p: string): string {
  return p.replace(/\\\\/g, '\\');
}

function getToolSummaryData(toolName: string, input: Record<string, unknown>): ToolSummaryPart[] {
  switch (toolName) {
    case 'Read': {
      const path = normalizePath(String(input.file_path || ''));
      return [{ type: 'file-link', content: path, filePath: path }];
    }
    case 'Write': {
      const path = normalizePath(String(input.file_path || ''));
      return [{ type: 'file-link', content: path, filePath: path }];
    }
    case 'Edit': {
      const path = normalizePath(String(input.file_path || ''));
      const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
      return [{ type: 'file-link', content: path, filePath: path, originalContent: oldString }];
    }
    case 'Glob':
      return [{ type: 'text', content: String(input.pattern || '') }];
    case 'Grep': {
      const pattern = String(input.pattern || '');
      const path = input.path ? normalizePath(String(input.path)) : '';
      return [{ type: 'text', content: path ? `${pattern} (in ${path})` : pattern }];
    }
    case 'Bash':
      return [{ type: 'text', content: String(input.description || input.command || '') }];
    case 'WebSearch':
      return [{ type: 'text', content: String(input.query || '') }];
    case 'WebFetch':
      return [{ type: 'text', content: String(input.url || '') }];
    case 'Agent':
    case 'subagent':
      return [{ type: 'text', content: String(input.description || input.prompt || '').slice(0, 100) }];
    case 'Skill':
      return [{ type: 'text', content: String(input.skill || '') }];
    case 'AskUserQuestion':
      return []; // 参数由 AskUserQuestionCard 展示
    default:
      return [{ type: 'text', content: String(input.description || input.prompt || JSON.stringify(input).slice(0, 80)) }];
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallCard({ toolName, input, result, status, durationMs, onFileClick }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summaryParts = getToolSummaryData(toolName, input);

  const dotColor = {
    pending: 'bg-muted-foreground/40',
    running: 'bg-yellow-500 animate-pulse',
    done: 'bg-green-500',
    error: 'bg-red-500',
  };

  return (
    <div className="border rounded-md my-2 bg-muted/20">
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded); }}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {status && <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor[status]}`} />}
        <span className="font-medium">{toolName}</span>
        <span className="text-muted-foreground truncate flex-1 text-left text-xs">
          {summaryParts.map((part, i) =>
            part.type === 'file-link' ? (
              <button
                key={i}
                className="text-primary hover:underline cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClick?.(part.filePath!, part.originalContent);
                }}
              >
                {part.content}
              </button>
            ) : (
              <span key={i}>{part.content}</span>
            )
          )}
        </span>
        {durationMs != null && (
          <span className="text-xs text-muted-foreground/50 shrink-0 tabular-nums"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </div>
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
