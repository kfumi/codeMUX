import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getCodeChangeFilePath, isCodeChangeTool, ToolCodeDiff } from './ToolCodeDiff';
import { getDisplayableArgs, getToolHeaderSummary } from './toolHeaderSummary';

interface ToolCallCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
  durationMs?: number;
  onFileClick?: (path: string, originalContent?: string) => void;
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
}: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const headerSummary = getToolHeaderSummary(toolName, input);
  const displayName = headerSummary.displayName || toolName;
  const codeFilePath = isCodeChangeTool(toolName, input) ? getCodeChangeFilePath(input) : undefined;
  const headerText = codeFilePath || headerSummary.text;
  const displayableArgs = codeFilePath ? null : getDisplayableArgs(input, headerSummary.consumedKeys);

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
        {headerText && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/72">
            {headerText}
          </span>
        )}
        <span className="flex-1 truncate text-left text-xs text-muted-foreground" />
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
          {displayableArgs && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground/60">
                参数
              </div>
              <pre
                className="max-h-40 overflow-auto rounded-xl border border-border/32 bg-muted/22 p-3 text-xs"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {JSON.stringify(displayableArgs, null, 2)}
              </pre>
            </div>
          )}

          <ToolCodeDiff toolName={toolName} input={input} />

          {!codeFilePath && result && (
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
