import { useMemo, useState } from 'react';
import {
  ChevronDown,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
  UploadCloud,
} from 'lucide-react';

import type {
  CreatePullRequestResult,
  GitPullRequestSuggestion,
  GitRepositoryState,
  GitStatusArea,
} from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../ui/dropdown-menu';
import { TooltipHint } from '../../ui/tooltip';
import { GitActionPopover } from './GitActionPopover';
import { GitPullRequestPopover } from './GitPullRequestPopover';

interface GitBranchBarProps {
  state: GitRepositoryState | null;
  area: GitStatusArea;
  totals: { additions: number; deletions: number };
  fileCount: number;
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
  prBase: string;
  prCreating: boolean;
  prCreateError: string | null;
  prResult: CreatePullRequestResult | null;
  onRefresh: () => void;
  onAreaChange: (area: GitStatusArea) => void;
  onStageAll: () => void;
  onRevertAll: () => void;
  onCommitMessageChange: (message: string) => void;
  onGenerateCommitMessage: () => void;
  onCommit: (options: { includeUnstaged: boolean; pushAfter: boolean }) => void;
  onPush: () => void;
  onGeneratePullRequest: () => void;
  onPrBaseChange: (base: string) => void;
  onCreatePullRequest: (request: { title: string; body: string; base: string }) => void;
}

export function GitBranchBar({
  state,
  area,
  totals,
  fileCount,
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
  prBase,
  prCreating,
  prCreateError,
  prResult,
  onRefresh,
  onAreaChange,
  onStageAll,
  onRevertAll,
  onCommitMessageChange,
  onGenerateCommitMessage,
  onCommit,
  onPush,
  onGeneratePullRequest,
  onPrBaseChange,
  onCreatePullRequest,
}: GitBranchBarProps) {
  const [actionOpen, setActionOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [modeOverride, setModeOverride] = useState<'commit' | 'push' | 'pr' | null>(null);
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
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border/25 px-4 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`审查范围：${area === 'unstaged' ? '未提交' : '已暂存'}`}
            data-testid="git-review-scope-trigger"
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-foreground/88 transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={loading || mutating || !state}
          >
            <span>{area === 'unstaged' ? '未提交' : '已暂存'}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" />
            <span className="ml-1 flex items-center gap-1 font-mono text-[10px] font-medium">
              <span className="text-[hsl(var(--success))]">+{totals.additions}</span>
              <span className="text-[hsl(var(--destructive))]">-{totals.deletions}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-260 min-w-32">
          <DropdownMenuItem
            onClick={() => onAreaChange('unstaged')}
            className={area === 'unstaged' ? 'font-medium text-primary' : undefined}
          >
            未提交
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onAreaChange('staged')}
            className={area === 'staged' ? 'font-medium text-primary' : undefined}
          >
            已暂存
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-1">
        <TooltipHint content={area === 'unstaged' ? '全部暂存' : '全部取消暂存'}>
          <button
            type="button"
            aria-label={area === 'unstaged' ? '全部暂存' : '全部取消暂存'}
            onClick={onStageAll}
            disabled={loading || mutating || fileCount === 0}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            {area === 'unstaged' ? <Upload className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
          </button>
        </TooltipHint>
        <TooltipHint content="全部还原">
          <button
            type="button"
            aria-label="全部还原"
            data-testid="git-revert-all"
            onClick={onRevertAll}
            disabled={loading || mutating || fileCount === 0}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Trash2 className="h-3.5 w-3.5" />
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
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </TooltipHint>
        <div className="flex items-center">
          {effectiveMode === 'pr' ? (
            <GitPullRequestPopover
              trigger={mainTrigger}
              branch={state?.currentBranch ?? null}
              branches={state?.branches ?? []}
              base={prBase}
              suggestion={prSuggestion}
              generating={prGenerating}
              creating={prCreating}
              error={prError}
              createError={prCreateError}
              result={prResult}
              open={prOpen}
              onOpenChange={handlePrOpenChange}
              onGenerate={onGeneratePullRequest}
              onBaseChange={onPrBaseChange}
              onCreate={onCreatePullRequest}
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
      </div>
    </div>
  );
}
