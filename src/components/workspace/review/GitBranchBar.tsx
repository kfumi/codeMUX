import { useMemo, useState } from 'react';
import { GitBranch, GitCommitHorizontal, Plus, RefreshCw, UploadCloud } from 'lucide-react';

import type { GitRepositoryState } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../ui/dropdown-menu';
import { GitActionPopover } from './GitActionPopover';

interface GitBranchBarProps {
  state: GitRepositoryState | null;
  loading: boolean;
  mutating: boolean;
  stagedCount: number;
  commitMessage: string;
  commitError: string | null;
  generatingCommitMessage: boolean;
  committing: boolean;
  pushing: boolean;
  onRefresh: () => void;
  onCheckout: (branchName: string) => void;
  onCreateBranch: () => void;
  onCommitMessageChange: (message: string) => void;
  onGenerateCommitMessage: () => void;
  onCommit: (options: { includeUnstaged: boolean; pushAfter: boolean }) => void;
  onPush: () => void;
}

export function GitBranchBar({
  state,
  loading,
  mutating,
  stagedCount,
  commitMessage,
  commitError,
  generatingCommitMessage,
  committing,
  pushing,
  onRefresh,
  onCheckout,
  onCreateBranch,
  onCommitMessageChange,
  onGenerateCommitMessage,
  onCommit,
  onPush,
}: GitBranchBarProps) {
  const [actionOpen, setActionOpen] = useState(false);
  const current = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';
  const actionMode = useMemo<'commit' | 'push' | null>(() => {
    if (!state) return null;
    if (state.hasUncommittedChanges || stagedCount > 0) return 'commit';
    if (state.hasUnpushedCommits) return 'push';
    return null;
  }, [stagedCount, state]);

  return (
    <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="切换分支"
              data-testid="git-branch-trigger"
              className="flex max-w-52 items-center gap-2 truncate rounded-lg border border-border/42 bg-background/80 px-2.5 py-1.5 text-sm text-foreground/86 transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading || mutating || !state}
            >
              <span className="truncate">{current}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="z-260 min-w-48">
            {(state?.branches ?? []).map((branch) => (
              <DropdownMenuItem
                key={branch.name}
                onClick={() => {
                  if (!branch.current) onCheckout(branch.name);
                }}
              >
                <span className={cn('truncate', branch.current && 'font-medium text-primary')}>
                  {branch.name}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {state?.hasUncommittedChanges && (
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            有未提交修改
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {actionMode && (
          <GitActionPopover
            state={state}
            loading={loading}
            open={actionOpen}
            mode={actionMode}
            message={commitMessage}
            stagedCount={stagedCount}
            generating={generatingCommitMessage}
            committing={committing}
            pushing={pushing}
            error={commitError}
            onOpenChange={setActionOpen}
            onMessageChange={onCommitMessageChange}
            onGenerate={onGenerateCommitMessage}
            onCommit={onCommit}
            onPush={onPush}
            trigger={(
              <button
                type="button"
                data-testid="git-action-trigger"
                aria-label={actionMode === 'commit' ? '打开提交窗口' : '打开推送窗口'}
                title={actionMode === 'commit' ? '提交' : '推送'}
                disabled={loading || mutating}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg border border-border/45 bg-background/92 px-2.5 text-xs font-medium transition-colors hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-50',
                  actionMode === 'commit' ? 'text-foreground/86' : 'text-primary',
                )}
              >
                {actionMode === 'commit' ? <GitCommitHorizontal className="h-3.5 w-3.5" /> : <UploadCloud className="h-3.5 w-3.5" />}
                {actionMode === 'commit' ? '提交' : '推送'}
              </button>
            )}
          />
        )}
        <button
          type="button"
          aria-label="新建分支"
          title="新建分支"
          data-testid="git-branch-create"
          onClick={onCreateBranch}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={onRefresh}
          disabled={loading}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>
    </div>
  );
}
