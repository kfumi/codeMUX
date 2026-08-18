import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

import { gitApi, type GitRepositoryState, type GitStatusChange } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { TooltipHint } from '../../ui/tooltip';
import { GitBranchDialog } from './GitBranchDialog';

function formatDelta(value: number): string {
  return value.toLocaleString('en-US');
}

function getTotals(files: GitStatusChange[]) {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function GitEnvironmentPopover({ projectPath }: { projectPath: string }) {
  const openReviewTab = useSidePanelStore((state) => state.openReviewTab);
  const [open, setOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [repositoryState, setRepositoryState] = useState<GitRepositoryState | null>(null);
  const [totals, setTotals] = useState({ additions: 0, deletions: 0 });
  const [branchQuery, setBranchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const [nextState, files] = await Promise.all([
        gitApi.getRepositoryState(projectPath),
        gitApi.getStatusChanges(projectPath, 'unstaged'),
      ]);
      setRepositoryState(nextState);
      setTotals(getTotals(files));
    } catch (err) {
      setError(String(err));
      setRepositoryState(null);
      setTotals({ additions: 0, deletions: 0 });
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const currentBranch = repositoryState?.detached
    ? 'detached HEAD'
    : repositoryState?.currentBranch ?? '无分支';
  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (!query) return repositoryState?.branches ?? [];
    return (repositoryState?.branches ?? []).filter((branch) => branch.name.toLowerCase().includes(query));
  }, [branchQuery, repositoryState?.branches]);

  const checkoutBranch = async (branchName: string) => {
    if (!projectPath || branchName === repositoryState?.currentBranch) return;
    setBranchLoading(true);
    setBranchError(null);
    try {
      await gitApi.checkoutBranch(projectPath, branchName);
      setBranchOpen(false);
      await load();
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setBranchLoading(false);
    }
  };

  const createBranch = async (branchName: string, checkout: boolean) => {
    if (!projectPath) return;
    setBranchLoading(true);
    setBranchError(null);
    try {
      await gitApi.createBranch(projectPath, branchName, checkout);
      setBranchDialogOpen(false);
      setBranchOpen(false);
      await load();
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setBranchLoading(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipHint content="切换摘要">
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="git-environment-trigger"
              aria-label="切换摘要"
              className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md border border-border/44 bg-[hsl(var(--surface-2))]/70 text-foreground/58 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipHint>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-72 rounded-xl border-border/70 bg-popover/98 p-1.5 shadow-[0_22px_58px_-34px_hsl(var(--surface-shadow-strong)/0.42)]"
        >
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-xs font-medium text-muted-foreground">环境信息</span>
            <TooltipHint content="新建分支">
              <button
                type="button"
                aria-label="新建分支"
                onClick={() => setBranchDialogOpen(true)}
                disabled={loading}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:opacity-45"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipHint>
          </div>

          <button
            type="button"
            data-testid="git-environment-changes"
            onClick={() => {
              openReviewTab(projectPath);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/45"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <GitCommitHorizontal className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">变更</span>
            <span className="shrink-0 font-mono text-ui-caption">
              <span className="text-[hsl(var(--success))]">+{formatDelta(totals.additions)}</span>
              <span className="ml-2 text-[hsl(var(--destructive))]">-{formatDelta(totals.deletions)}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground/55" />
          </button>

          <Popover open={branchOpen} onOpenChange={setBranchOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="git-environment-branch"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/45"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/65 text-muted-foreground">
                  <GitBranch className="h-3 w-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <TooltipHint content={currentBranch}>
                    <span className="block truncate text-xs text-foreground/88">{currentBranch}</span>
                  </TooltipHint>
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/55" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="left"
              sideOffset={8}
              className="w-64 rounded-xl border-border/70 bg-popover/98 p-1.5 shadow-[0_22px_58px_-34px_hsl(var(--surface-shadow-strong)/0.42)]"
            >
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/65" />
                <Input
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  placeholder="搜索分支"
                  aria-label="搜索分支"
                  className="h-8 rounded-lg pl-8 text-xs"
                  autoFocus
                />
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto">
                {filteredBranches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    disabled={branchLoading || branch.current}
                    onClick={() => void checkoutBranch(branch.name)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <GitBranch className={cn('h-3.5 w-3.5', branch.current ? 'text-primary' : 'text-muted-foreground')} />
                    <TooltipHint content={branch.name}>
                      <span className={cn('min-w-0 flex-1 truncate', branch.current && 'font-medium text-primary')}>
                        {branch.name}
                      </span>
                    </TooltipHint>
                    {branch.current && <span className="text-ui-micro text-muted-foreground">当前</span>}
                  </button>
                ))}
              </div>
              {branchError && <p className="px-2 py-1 text-xs text-destructive">{branchError}</p>}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 w-full justify-start gap-2 px-2 text-xs"
                onClick={() => {
                  setBranchOpen(false);
                  setBranchDialogOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                创建并检出新分支...
              </Button>
            </PopoverContent>
          </Popover>

          {error && <p className="px-1.5 py-1 text-xs text-destructive">{error}</p>}
        </PopoverContent>
      </Popover>
      <GitBranchDialog
        open={branchDialogOpen}
        loading={branchLoading}
        error={branchError}
        onOpenChange={setBranchDialogOpen}
        onCreate={(branchName, checkout) => void createBranch(branchName, checkout)}
      />
    </>
  );
}
