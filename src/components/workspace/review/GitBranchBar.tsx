import { useMemo, useState } from 'react';
import { ChevronDown, GitBranch, GitCommitHorizontal, GitPullRequest, Plus, RefreshCw, UploadCloud } from 'lucide-react';

import type { GitPullRequestSuggestion, GitRepositoryState } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../ui/dropdown-menu';
import { TooltipHint } from '../../ui/tooltip';
import { GitActionPopover } from './GitActionPopover';
import { GitPullRequestPopover } from './GitPullRequestPopover';

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
  prSuggestion: GitPullRequestSuggestion | null;
  prGenerating: boolean;
  prError: string | null;
  onRefresh: () => void;
  onCheckout: (branchName: string) => void;
  onCreateBranch: () => void;
  onCommitMessageChange: (message: string) => void;
  onGenerateCommitMessage: () => void;
  onCommit: (options: { includeUnstaged: boolean; pushAfter: boolean }) => void;
  onPush: () => void;
  onGeneratePullRequest: () => void;
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
  prSuggestion,
  prGenerating,
  prError,
  onRefresh,
  onCheckout,
  onCreateBranch,
  onCommitMessageChange,
  onGenerateCommitMessage,
  onCommit,
  onPush,
  onGeneratePullRequest,
}: GitBranchBarProps) {
  const [actionOpen, setActionOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [modeOverride, setModeOverride] = useState<'commit' | 'push' | 'pr' | null>(null);
  const current = state?.detached ? 'detached HEAD' : state?.currentBranch ?? '无分支';
  const actionMode = useMemo<'commit' | 'push' | null>(() => {
    if (!state) return null;
    if (state.hasUncommittedChanges || stagedCount > 0) return 'commit';
    if (state.hasUnpushedCommits) return 'push';
    return null;
  }, [stagedCount, state]);
  const effectiveMode = modeOverride ?? actionMode ?? 'commit';
  const canCommit = Boolean(state) && (state?.hasUncommittedChanges || stagedCount > 0);
  const canPush = Boolean(state?.hasUnpushedCommits);
  const canPullRequest = Boolean(state?.currentBranch) && !state?.detached;

  const handlePrOpenChange = (open: boolean) => {
    setPrOpen(open);
    // 打开弹层即自动生成一次（已有结果或正在生成时跳过）。
    if (open && !prSuggestion && !prGenerating) {
      onGeneratePullRequest();
    }
  };

  const switchAction = (mode: 'commit' | 'push' | 'pr') => {
    setActionsMenuOpen(false);
    setModeOverride(mode);
    if (mode === 'pr') {
      setActionOpen(false);
      // 与提交/推送一致：与菜单关闭同批提交中打开弹层。
      handlePrOpenChange(true);
    } else {
      setPrOpen(false);
      setActionOpen(true);
    }
  };

  const mainTrigger = (
    <button
      type="button"
      data-testid="git-action-trigger"
      aria-label={effectiveMode === 'push' ? '打开推送窗口' : effectiveMode === 'pr' ? '打开拉取请求窗口' : '打开提交窗口'}
      disabled={loading || mutating || (effectiveMode === 'pr' && !canPullRequest)}
      className="flex h-8 items-center gap-1.5 rounded-l-lg border border-r-0 border-border/45 bg-background/92 px-2.5 text-xs font-medium text-foreground/86 transition-colors hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {effectiveMode === 'push' ? <UploadCloud className="h-3.5 w-3.5" /> : effectiveMode === 'pr' ? <GitPullRequest className="h-3.5 w-3.5" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
      {effectiveMode === 'push' ? '推送' : effectiveMode === 'pr' ? '拉取请求' : '提交'}
    </button>
  );

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
        <div className="flex items-center">
          {effectiveMode === 'pr' ? (
            <GitPullRequestPopover
              trigger={mainTrigger}
              branch={state?.currentBranch ?? null}
              suggestion={prSuggestion}
              generating={prGenerating}
              error={prError}
              open={prOpen}
              onOpenChange={handlePrOpenChange}
              onGenerate={onGeneratePullRequest}
            />
          ) : (
            <GitActionPopover
              trigger={mainTrigger}
              state={state}
              loading={loading}
              open={actionOpen}
              mode={effectiveMode === 'push' ? 'push' : 'commit'}
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
            />
          )}
          <DropdownMenu open={actionsMenuOpen} onOpenChange={setActionsMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="git-actions-trigger"
                aria-label="切换 Git 操作"
                disabled={loading || mutating}
                className="flex h-8 items-center rounded-r-lg border border-l-0 border-border/45 bg-background/92 px-1.5 text-foreground/70 transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="z-260 min-w-44"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuItem
                data-testid="git-actions-commit"
                disabled={!canCommit}
                onClick={() => switchAction('commit')}
              >
                <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
                提交
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="git-actions-push"
                disabled={!canPush}
                onClick={() => switchAction('push')}
              >
                <UploadCloud className="h-4 w-4 text-muted-foreground" />
                推送
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="git-actions-pr"
                disabled={!canPullRequest}
                onClick={() => switchAction('pr')}
              >
                <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                创建拉取请求
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <TooltipHint content="新建分支">
          <button
            type="button"
            aria-label="新建分支"
            data-testid="git-branch-create"
            onClick={onCreateBranch}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </TooltipHint>
        <TooltipHint content="刷新">
          <button
            type="button"
            aria-label="刷新"
            onClick={onRefresh}
            disabled={loading}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </TooltipHint>
      </div>
    </div>
  );
}
