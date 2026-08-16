import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';

import { DiffViewer } from '../../lib/diff/diff-viewer';
import { parseUnifiedDiffPatch } from '../../lib/diff/diffStats';

import type { SessionSummaryDiff } from '../../lib/eventToMessages';
import { cn } from '../../lib/utils';

interface SessionSummaryRowProps {
  diffs: SessionSummaryDiff[];
}

function getSummaryFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function SessionSummaryRow({ diffs }: SessionSummaryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const totalAdditions = diffs.reduce((sum, diff) => sum + (diff.additions ?? 0), 0);
  const totalDeletions = diffs.reduce((sum, diff) => sum + (diff.deletions ?? 0), 0);
  const selected = diffs.find((diff) => diff.file === activeFile) ?? null;

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border/60 bg-[hsl(var(--surface-2))]">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        )}
        <FileText className="h-4 w-4 shrink-0 text-primary/80" />
        <span className="font-medium text-foreground/85">{diffs.length} 个文件已更改</span>
        <span className="ml-auto inline-flex items-center gap-1.5 tabular-nums">
          {totalAdditions > 0 ? (
            <span className="rounded-md bg-[hsl(var(--success)/0.11)] px-1.5 py-0.5 text-xs font-medium text-[hsl(var(--success))]">
              +{totalAdditions}
            </span>
          ) : null}
          {totalDeletions > 0 ? (
            <span className="rounded-md bg-[hsl(var(--destructive)/0.11)] px-1.5 py-0.5 text-xs font-medium text-[hsl(var(--destructive))]">
              −{totalDeletions}
            </span>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className="divide-y divide-border/35 border-t border-border/45">
          {diffs.map((diff) => (
            <button
              key={diff.file}
              type="button"
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs transition-colors hover:bg-muted/30',
                activeFile === diff.file && 'bg-muted/40',
              )}
              onClick={() => setActiveFile((current) => (current === diff.file ? null : diff.file))}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">{getSummaryFileName(diff.file)}</span>
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                {(diff.additions ?? 0) > 0 ? (
                  <span className="text-[hsl(var(--success))]">+{diff.additions}</span>
                ) : null}
                {(diff.deletions ?? 0) > 0 ? (
                  <span className="text-[hsl(var(--destructive))]">−{diff.deletions}</span>
                ) : null}
              </span>
            </button>
          ))}
          {selected ? (
            <div className="border-t border-border/35 p-3">
              <SummaryDiffPreview diff={selected} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SummaryDiffPreview({ diff }: { diff: SessionSummaryDiff }) {
  if (diff.patch) {
    const parsed = parseUnifiedDiffPatch(diff.patch);
    if (parsed) {
      return (
        <DiffViewer
          oldFile={parsed.oldContent}
          newFile={parsed.newContent}
          oldFileName={diff.file}
          newFileName={diff.file}
          viewMode="unified"
          showIcon={false}
          showHunkHeaders={false}
          showNoNewlineMarker={false}
          className="max-h-80 overflow-auto border-border/45 text-code"
        />
      );
    }
  }

  if (typeof diff.before === 'string' && typeof diff.after === 'string') {
    return (
      <DiffViewer
        oldFile={diff.before}
        newFile={diff.after}
        oldFileName={diff.file}
        newFileName={diff.file}
        viewMode="unified"
        showIcon={false}
        showHunkHeaders={false}
        showNoNewlineMarker={false}
        className="max-h-80 overflow-auto border-border/45 text-code"
      />
    );
  }

  return <div className="text-xs text-muted-foreground">暂无可预览的 diff 内容</div>;
}
