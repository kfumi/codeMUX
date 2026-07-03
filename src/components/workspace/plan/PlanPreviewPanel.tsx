import { FileText } from 'lucide-react';

import { MarkdownRenderer } from '../../agent/MarkdownRenderer';

function displayName(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path || '计划';
}

export function PlanPreviewPanel({
  planFilePath,
  planContent,
}: {
  planFilePath?: string;
  planContent?: string;
}) {
  const content = planContent?.trim() ?? '';

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-15 shrink-0 items-center gap-3 border-b border-border/25 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/45 text-muted-foreground/80">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground/88">
            {displayName(planFilePath ?? '')}
          </div>
          {planFilePath ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/58" title={planFilePath}>
              {planFilePath}
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {content ? (
          <div className="text-sm leading-6 text-foreground/86">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/55">
            暂无计划内容
          </div>
        )}
      </div>
    </div>
  );
}
