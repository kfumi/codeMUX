import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

import type { SubagentStatus } from '../../../lib/codeMuxProtocol';
import { daemonFacade } from '../../../lib/facades/daemon-facade';
import type { GitRepositoryState, GitStatusChange } from '../../../lib/gitTypes';
import { cn } from '../../../lib/utils';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { subagentTabTitle, useSubagentStore } from '../../../stores/subagentStore';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { TooltipHint } from '../../ui/tooltip';
import type { TodoItem } from '../../../types/agent';
import { GitBranchDialog } from './GitBranchDialog';

function getTodoStatusIcon(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 5.5 4 7.5 8 3" />
          </svg>
        </span>
      );
    case 'in_progress':
      return (
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-[hsl(var(--warning)/0.4)]" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[hsl(var(--warning))]" />
        </span>
      );
    case 'pending':
      return (
        <span className="flex h-4 w-4 items-center justify-center">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/20" />
        </span>
      );
  }
}

/** 超过该数量时折叠前面的条目，仅展示最后 N 条 */
const MAX_VISIBLE_LIST_ITEMS = 3;

function TodoSection({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(true);

  if (todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const total = todos.length;
  const hiddenCount = todos.length - MAX_VISIBLE_LIST_ITEMS;
  const hasOverflow = hiddenCount > 0;
  const visibleTodos = hasOverflow && collapsed ? todos.slice(-MAX_VISIBLE_LIST_ITEMS) : todos;

  return (
    <div className="mt-1.5 border-t border-border/45 pt-1.5" data-testid="git-environment-todos">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-xs font-medium text-muted-foreground">任务</span>
        <span className="text-ui-meta text-muted-foreground/50 tabular-nums">{completed}/{total}</span>
      </div>
      {hasOverflow && collapsed && (
        <button
          type="button"
          data-testid="git-environment-todos-expand"
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3 rotate-[-90deg] transition-transform" />
          展示前面 {hiddenCount} 条已完成/更早的任务
        </button>
      )}
      <div className="space-y-0.5 px-1.5 pb-1">
        {visibleTodos.map((todo, i) => (
          <div key={i} className="flex items-start gap-2.5 rounded-md px-1 py-1 text-xs leading-relaxed">
            <span className="mt-0.5 shrink-0">{getTodoStatusIcon(todo.status)}</span>
            <span className={
              todo.status === 'completed'
                ? 'text-muted-foreground/40 line-through'
                : todo.status === 'in_progress'
                  ? 'text-foreground/90 font-medium'
                  : 'text-foreground/60'
            }>
              {todo.status === 'in_progress' && todo.activeForm
                ? todo.activeForm
                : todo.content}
            </span>
          </div>
        ))}
        {hasOverflow && !collapsed && (
          <button
            type="button"
            data-testid="git-environment-todos-collapse"
            onClick={() => setCollapsed(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3 rotate-[-90deg] transition-transform" />
            收起前面 {hiddenCount} 条
          </button>
        )}
      </div>
    </div>
  );
}

function getSubagentStatusIcon(status: SubagentStatus) {
  switch (status) {
    case 'running':
      return (
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-[hsl(var(--warning)/0.4)]" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[hsl(var(--warning))]" />
        </span>
      );
    case 'completed':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 5.5 4 7.5 8 3" />
          </svg>
        </span>
      );
    case 'failed':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3L7 7M7 3L3 7" />
          </svg>
        </span>
      );
    case 'canceled':
      return (
        <span className="flex h-4 w-4 items-center justify-center">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/35" />
        </span>
      );
  }
}

function SubagentSection({ sessionId, onOpenSubagent }: { sessionId: string | null; onOpenSubagent: () => void }) {
  const [collapsed, setCollapsed] = useState(true);
  const sessionSubagents = useSubagentStore((state) => (sessionId ? state.sessions[sessionId] : undefined));
  const openInSidePanel = useSubagentStore((state) => state.openInSidePanel);

  const subagents = useMemo(() => {
    if (!sessionSubagents) return [];
    return sessionSubagents.order
      .map((id) => sessionSubagents.descriptors[id])
      .filter((descriptor): descriptor is NonNullable<typeof descriptor> => Boolean(descriptor));
  }, [sessionSubagents]);

  if (subagents.length === 0) return null;

  const completed = subagents.filter((subagent) => subagent.status === 'completed').length;
  const total = subagents.length;
  const hiddenCount = subagents.length - MAX_VISIBLE_LIST_ITEMS;
  const hasOverflow = hiddenCount > 0;
  const visibleSubagents = hasOverflow && collapsed ? subagents.slice(-MAX_VISIBLE_LIST_ITEMS) : subagents;

  return (
    <div className="mt-1.5 border-t border-border/45 pt-1.5" data-testid="git-environment-subagents">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-xs font-medium text-muted-foreground">子智能体</span>
        <span className="text-ui-meta text-muted-foreground/50 tabular-nums">{completed}/{total}</span>
      </div>
      {hasOverflow && collapsed && (
        <button
          type="button"
          data-testid="git-environment-subagents-expand"
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3 -rotate-90 transition-transform" />
          展示前面 {hiddenCount} 个更早的子智能体
        </button>
      )}
      <div className="space-y-0.5 px-1.5 pb-1">
        {visibleSubagents.map((subagent) => (
          <button
            key={subagent.subagentId}
            type="button"
            data-testid={`git-environment-subagent-${subagent.subagentId}`}
            onClick={() => {
              if (!sessionId) return;
              openInSidePanel(sessionId, subagent.subagentId);
              onOpenSubagent();
            }}
            className="flex w-full items-start gap-2.5 rounded-md px-1 py-1 text-left text-xs leading-relaxed transition-colors hover:bg-muted/45"
          >
            <span className="mt-0.5 shrink-0">{getSubagentStatusIcon(subagent.status)}</span>
            <span className="min-w-0 flex-1">
              <span className={cn(
                'block truncate',
                subagent.status === 'running'
                  ? 'font-medium text-foreground/90'
                  : subagent.status === 'failed'
                    ? 'text-destructive/85'
                    : subagent.status === 'canceled'
                      ? 'text-muted-foreground/45 line-through'
                      : 'text-foreground/70',
              )}>
                {subagentTabTitle(subagent)}
              </span>
            </span>
            <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
          </button>
        ))}
        {hasOverflow && !collapsed && (
          <button
            type="button"
            data-testid="git-environment-subagents-collapse"
            onClick={() => setCollapsed(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3 -rotate-90 transition-transform" />
            收起前面 {hiddenCount} 个
          </button>
        )}
      </div>
    </div>
  );
}

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

type GitLoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

function EnvironmentRowSkeleton() {
  return (
    <div className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5" aria-hidden>
      <span className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-muted/60" />
      <span className="h-3 flex-1 animate-pulse rounded bg-muted/50" />
      <span className="h-3 w-12 shrink-0 animate-pulse rounded bg-muted/40" />
    </div>
  );
}

function EnvironmentSection({
  gitLoadState,
  unavailableMessage,
  totals,
  currentBranch,
  branchOpen,
  onBranchOpenChange,
  branchQuery,
  onBranchQueryChange,
  filteredBranches,
  branchLoading,
  branchError,
  onCheckoutBranch,
  onOpenReview,
  onOpenBranchDialog,
}: {
  gitLoadState: GitLoadState;
  unavailableMessage: string | null;
  totals: { additions: number; deletions: number };
  currentBranch: string;
  branchOpen: boolean;
  onBranchOpenChange: (open: boolean) => void;
  branchQuery: string;
  onBranchQueryChange: (value: string) => void;
  filteredBranches: GitRepositoryState['branches'];
  branchLoading: boolean;
  branchError: string | null;
  onCheckoutBranch: (branchName: string) => void;
  onOpenReview: () => void;
  onOpenBranchDialog: () => void;
}) {
  return (
    <div data-testid="git-environment-section">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-xs font-medium text-muted-foreground">环境信息</span>
      </div>

      {gitLoadState === 'loading' ? (
        <div data-testid="git-environment-loading" className="space-y-0.5">
          <EnvironmentRowSkeleton />
          <EnvironmentRowSkeleton />
        </div>
      ) : null}

      {gitLoadState === 'ready' ? (
        <>
          <button
            type="button"
            data-testid="git-environment-changes"
            onClick={onOpenReview}
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

          <Popover open={branchOpen} onOpenChange={onBranchOpenChange}>
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
                  onChange={(event) => onBranchQueryChange(event.target.value)}
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
                    onClick={() => onCheckoutBranch(branch.name)}
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
              {branchError ? <p className="px-2 py-1 text-xs text-destructive">{branchError}</p> : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 w-full justify-start gap-2 px-2 text-xs"
                onClick={onOpenBranchDialog}
              >
                <Plus className="h-3.5 w-3.5" />
                创建并检出新分支...
              </Button>
            </PopoverContent>
          </Popover>
        </>
      ) : null}

      {gitLoadState === 'unavailable' ? (
        <p
          data-testid="git-environment-unavailable"
          className="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground/70"
        >
          {unavailableMessage ?? '当前项目不是 Git 仓库'}
        </p>
      ) : null}
    </div>
  );
}

export function GitEnvironmentPopover({ projectPath, todos = [] }: { projectPath: string; todos?: TodoItem[] }) {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const openReviewTab = useSidePanelStore((state) => state.openReviewTab);
  const [open, setOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [repositoryState, setRepositoryState] = useState<GitRepositoryState | null>(null);
  const [totals, setTotals] = useState({ additions: 0, deletions: 0 });
  const [branchQuery, setBranchQuery] = useState('');
  const [gitLoadState, setGitLoadState] = useState<GitLoadState>('idle');
  const [branchLoading, setBranchLoading] = useState(false);
  const [unavailableMessage, setUnavailableMessage] = useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setGitLoadState((prev) => (prev === 'ready' ? prev : 'loading'));
    setUnavailableMessage(null);
    try {
      const [nextState, files] = await Promise.all([
        daemonFacade.git.getRepositoryState(projectPath),
        daemonFacade.git.getStatusChanges(projectPath, 'unstaged').catch(() => []),
      ]);
      setRepositoryState(nextState);
      setTotals(getTotals(files));
      setGitLoadState('ready');
    } catch (err) {
      setUnavailableMessage(String(err));
      setRepositoryState(null);
      setTotals({ additions: 0, deletions: 0 });
      setGitLoadState('unavailable');
    }
  }, [projectPath]);

  useEffect(() => {
    setGitLoadState('idle');
    setRepositoryState(null);
    setTotals({ additions: 0, deletions: 0 });
    setUnavailableMessage(null);
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
      await daemonFacade.git.checkoutBranch(projectPath, branchName);
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
      await daemonFacade.git.createBranch(projectPath, branchName, checkout);
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
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && gitLoadState === 'idle') {
            setGitLoadState('loading');
          }
          setOpen(nextOpen);
        }}
      >
        <TooltipHint content="切换摘要">
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="git-environment-trigger"
              aria-label="切换摘要"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground/52 transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground data-[state=open]:bg-foreground/8 data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipHint>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-84 rounded-xl border-border/70 bg-popover/98 p-1.5 shadow-[0_22px_58px_-34px_hsl(var(--surface-shadow-strong)/0.42)]"
        >
          <EnvironmentSection
            gitLoadState={gitLoadState}
            unavailableMessage={unavailableMessage}
            totals={totals}
            currentBranch={currentBranch}
            branchOpen={branchOpen}
            onBranchOpenChange={setBranchOpen}
            branchQuery={branchQuery}
            onBranchQueryChange={setBranchQuery}
            filteredBranches={filteredBranches}
            branchLoading={branchLoading}
            branchError={branchError}
            onCheckoutBranch={(branchName) => void checkoutBranch(branchName)}
            onOpenReview={() => {
              openReviewTab(projectPath);
              setOpen(false);
            }}
            onOpenBranchDialog={() => {
              setBranchOpen(false);
              setBranchDialogOpen(true);
            }}
          />

          <TodoSection todos={todos} />

          <SubagentSection sessionId={activeSessionId} onOpenSubagent={() => setOpen(false)} />
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
