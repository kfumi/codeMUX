import { GitBranch, Plus, RefreshCw } from 'lucide-react';

import type { GitRepositoryState } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DropdownMenu, DropdownMenuItem } from '../../ui/dropdown-menu';

interface GitBranchBarProps {
  state: GitRepositoryState | null;
  loading: boolean;
  mutating: boolean;
  onRefresh: () => void;
  onCheckout: (branchName: string) => void;
  onCreateBranch: () => void;
}

export function GitBranchBar({
  state,
  loading,
  mutating,
  onRefresh,
  onCheckout,
  onCreateBranch,
}: GitBranchBarProps) {
  const current = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';

  return (
    <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <DropdownMenu
          align="left"
          panelClassName="z-260 min-w-48"
          trigger={(
            <button
              type="button"
              aria-label="切换分支"
              data-testid="git-branch-trigger"
              className="flex max-w-52 items-center gap-2 truncate rounded-lg border border-border/42 bg-background/80 px-2.5 py-1.5 text-sm text-foreground/86 transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading || mutating || !state}
            >
              <span className="truncate">{current}</span>
            </button>
          )}
        >
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
        </DropdownMenu>
        {state?.hasUncommittedChanges && (
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            有未提交修改
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
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
