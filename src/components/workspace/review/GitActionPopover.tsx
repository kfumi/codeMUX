import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, GitCommitHorizontal, UploadCloud } from 'lucide-react';

import type { GitRepositoryState } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';

interface GitActionPopoverProps {
  trigger: ReactNode;
  state: GitRepositoryState | null;
  loading: boolean;
  open: boolean;
  mode: 'commit' | 'push';
  message: string;
  stagedCount: number;
  generating: boolean;
  committing: boolean;
  pushing: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onCommit: (options: { includeUnstaged: boolean; pushAfter: boolean }) => void;
  onPush: () => void;
}

export function GitActionPopover({
  trigger,
  state,
  loading,
  open,
  mode,
  message,
  stagedCount,
  generating,
  committing,
  pushing,
  error,
  onOpenChange,
  onMessageChange,
  onGenerate,
  onCommit,
  onPush,
}: GitActionPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const busy = loading || generating || committing || pushing;
  const branch = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';
  const canIncludeUnstaged = Boolean(state?.hasUncommittedChanges);
  const shouldIncludeUnstaged = includeUnstaged && canIncludeUnstaged;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [message, open]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-border/70 bg-popover/98 p-3 shadow-[0_22px_58px_-34px_hsl(var(--foreground)/0.42),0_0_0_1px_hsl(var(--background)/0.7)] backdrop-blur-md dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.97,hsl(var(--surface-1))/0.95)]"
        data-testid="git-action-popover"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground/90">{branch}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {mode === 'commit'
                ? `${stagedCount} 个已暂存文件`
                : `${state?.aheadCount ?? 0} 个提交待推送`}
            </div>
          </div>
          {mode === 'push' && (
            <UploadCloud className="h-4 w-4 shrink-0 text-primary" />
          )}
        </div>

        {mode === 'commit' ? (
          <>
            <textarea
              ref={textareaRef}
              aria-label="提交信息"
              data-testid="git-commit-message"
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
              placeholder="提交信息，留空将自动生成"
              disabled={busy}
              rows={2}
              className="max-h-36 min-h-18 w-full resize-none overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm text-foreground/82">
              <input
                type="checkbox"
                checked={shouldIncludeUnstaged}
                onChange={(event) => setIncludeUnstaged(event.target.checked)}
                disabled={busy || !canIncludeUnstaged}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              包含未暂存的更改
            </label>
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="AI 生成提交信息"
                data-testid="git-commit-generate"
                onClick={onGenerate}
                disabled={busy || stagedCount === 0}
                className="shrink-0"
              >
                <Bot className="mr-1.5 h-3.5 w-3.5" />
                AI
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="git-commit-submit"
                onClick={() => onCommit({ includeUnstaged: shouldIncludeUnstaged, pushAfter: false })}
                disabled={busy || (stagedCount === 0 && !shouldIncludeUnstaged)}
                className="flex-1"
              >
                <GitCommitHorizontal className="mr-1.5 h-3.5 w-3.5" />
                提交
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-commit-push-submit"
                onClick={() => onCommit({ includeUnstaged: shouldIncludeUnstaged, pushAfter: true })}
                disabled={busy || (stagedCount === 0 && !shouldIncludeUnstaged)}
                className="flex-1"
              >
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                提交并推送
              </Button>
            </div>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            data-testid="git-push-submit"
            onClick={onPush}
            disabled={busy}
            className="mt-1 w-full"
          >
            <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
            推送
          </Button>
        )}

        {error && (
          <p className={cn('mt-2 text-xs text-destructive', mode === 'push' && 'mt-3')}>
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
