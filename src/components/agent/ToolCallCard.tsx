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
  type: 'text' | 'file-link' | 'mcp';
  content: string | { method: string; query: string };
  filePath?: string;
  originalContent?: string;
  displayAs?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\\\/g, '\\');
}

function getToolSummaryData(toolName: string, input: Record<string, unknown>): ToolSummaryPart[] {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1] || toolName;
    const method = parts[2] || '';
    const query = String(input.query || input.libraryName || input.libraryId || '');
    const summary = query ? { method: ` [${method}]`, query: ` ${query}` } : { method: ` [${method}]`, query: '' };
    return [{ type: 'mcp', content: summary, displayAs: server }];
  }

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
    case 'TaskList':
      return [];
    case 'TaskGet':
      return [{ type: 'text', content: String(input.taskId || '') }];
    case 'TaskCreate':
      return [{ type: 'text', content: String(input.subject || input.description || '') }];
    case 'TaskUpdate': {
      const parts = [];
      if (input.taskId) parts.push(`#${input.taskId}`);
      if (input.status) parts.push(`[${input.status}]`);
      if (input.subject) parts.push(String(input.subject));
      return [{ type: 'text', content: parts.join(' ') || '' }];
    }
    case 'AskUserQuestion':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'WaitForMcpServers':
      return [];
    default:
      return [{ type: 'text', content: String(input.description || input.prompt || JSON.stringify(input).slice(0, 80)) }];
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_DOT = {
  pending: 'bg-muted-foreground/30',
  running: 'bg-[hsl(var(--warning))] animate-pulse-soft',
  done: 'bg-[hsl(var(--success))]',
  error: 'bg-[hsl(var(--destructive))]',
};

export function ToolCallCard({
  toolName,
  input,
  result,
  status,
  durationMs,
  onFileClick,
}: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summaryParts = getToolSummaryData(toolName, input);
  const displayName = summaryParts[0]?.displayAs || toolName;

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-[0_1px_0_hsl(var(--foreground)/0.018)] transition-colors duration-200 hover:bg-muted/10">
      <div
        role="button"
        tabIndex={0}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <span className="text-muted-foreground/50">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        {status && <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />}
        <span className="text-[13px] font-medium text-foreground">{displayName}</span>
        <span className="flex-1 truncate text-left text-xs text-muted-foreground">
          {summaryParts.map((part, index) => {
            if (part.type === 'mcp') {
              const { method, query } = part.content as { method: string; query: string };
              return (
                <span key={index}>
                  <span className="font-medium text-foreground/80">{method}</span>
                  <span>{query}</span>
                </span>
              );
            }

            if (part.type === 'file-link') {
              return (
                <button
                  key={index}
                  className="cursor-pointer text-[hsl(var(--primary))] hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFileClick?.(part.filePath!, part.originalContent);
                  }}
                >
                  {String(part.content)}
                </button>
              );
            }

            return <span key={index}>{String(part.content)}</span>;
          })}
        </span>
        {durationMs != null && (
          <span
            className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground/70"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </div>

      {isExpanded && (
        <div className="animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease] space-y-2.5 border-t border-border/40 px-3.5 py-3">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground/60">
              参数
            </div>
            <pre
              className="max-h-40 overflow-auto rounded-xl border border-border/32 bg-muted/22 p-3 text-xs"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {result && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground/60">
                结果
              </div>
              <pre
                className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-border/32 bg-muted/22 p-3 text-xs"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
