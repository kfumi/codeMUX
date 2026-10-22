import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  MessageSquare,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  getBranchPickerLabel,
  getWorktreeTriggerLabel,
} from '../../lib/draftWorkspacePicker';
// 工单 06:平台分流 —— Electron 走壳桥 dialog,Tauri 走 plugin-dialog。
import { openDialog } from '../../lib/desktopDialogs';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import type { GitRepositoryState, GitWorktree } from '../../lib/gitTypes';
import { cn } from '../../lib/utils';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { useProjectStore } from '../../stores/projectStore';
import type { Project } from '../../types/project';
import { getPrimaryProjectRoot, getProjectRootPaths } from '../../types/project';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { TooltipHint } from '../ui/tooltip';

function getProjectLabel(project: Project | null): string {
  if (!project) {
    return '不在项目中工作';
  }
  return project.name;
}

interface DraftWorkspaceToolbarProps {
  className?: string;
}

export function DraftWorkspaceToolbar({ className }: DraftWorkspaceToolbarProps) {
  // 工单 02:「打开文件夹」依赖壳的原生目录选择框,浏览器/移动形态隐藏入口。
  const canPickDirectory = useHostCapabilities().has('dialog.directory');
  const projects = useProjectStore((state) => state.projects);
  const createProject = useProjectStore((state) => state.createProject);
  const draftProjectId = useNewSessionStore((state) => state.draftProjectId);
  const draftWorkspace = useNewSessionStore((state) => state.draftWorkspace);
  const setDraftProjectId = useNewSessionStore((state) => state.setDraftProjectId);
  const setDraftWorkspace = useNewSessionStore((state) => state.setDraftWorkspace);

  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );

  const [projectOpen, setProjectOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
  const [repositoryState, setRepositoryState] = useState<GitRepositoryState | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);

  const isWorktreeMode = draftWorkspace.kind === 'worktree';
  const worktreeBaseRef = draftWorkspace.kind === 'worktree' ? draftWorkspace.baseRef : null;
  const existingWorktreePath = draftWorkspace.kind === 'existing' ? draftWorkspace.worktreePath : null;

  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      project.name.toLowerCase().includes(query)
      || getProjectRootPaths(project).some((root) => root.toLowerCase().includes(query)),
    );
  }, [projectQuery, projects]);

  // Git、worktree 这一版只服务主根。
  const draftProjectRoot = getPrimaryProjectRoot(draftProject);

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (!query) return repositoryState?.branches ?? [];
    return (repositoryState?.branches ?? []).filter((branch) =>
      branch.name.toLowerCase().includes(query),
    );
  }, [branchQuery, repositoryState?.branches]);

  const worktreeTriggerLabel = getWorktreeTriggerLabel(draftWorkspace, worktrees);
  const branchPickerLabel = getBranchPickerLabel(worktreeBaseRef, repositoryState);

  const loadGitContext = useCallback(async () => {
    if (!draftProjectRoot) {
      setRepositoryState(null);
      setWorktrees([]);
      setGitAvailable(false);
      return;
    }

    const statePath = existingWorktreePath ?? draftProjectRoot;

    setGitLoading(true);
    try {
      const [state, nextWorktrees] = await Promise.all([
        daemonFacade.git.getRepositoryState(statePath),
        daemonFacade.git.listWorktrees(draftProjectRoot),
      ]);
      setRepositoryState(state);
      setWorktrees(nextWorktrees);
      setGitAvailable(true);
    } catch {
      setRepositoryState(null);
      setWorktrees([]);
      setGitAvailable(false);
    } finally {
      setGitLoading(false);
    }
  }, [draftProjectRoot, existingWorktreePath]);

  useEffect(() => {
    void loadGitContext();
  }, [loadGitContext]);

  useEffect(() => {
    if (!existingWorktreePath || isWorktreeMode) {
      return;
    }
    const stillExists = worktrees.some((entry) => entry.path === existingWorktreePath);
    if (!stillExists && !gitLoading) {
      setDraftWorkspace({ kind: 'local' });
    }
  }, [existingWorktreePath, gitLoading, isWorktreeMode, setDraftWorkspace, worktrees]);

  const handleOpenFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: '选择项目文件夹（可多选）',
      });
      if (!selected || selected.length === 0) {
        return;
      }
      // 原生选择器的返回顺序即根顺序：第一个成为主根。
      const roots = Array.isArray(selected) ? selected : [selected];
      const name = roots[0].split(/[/\\]/).filter(Boolean).pop() || roots[0];
      const project = await createProject(name, roots);
      setDraftProjectId(project.id);
      setProjectOpen(false);
      setProjectQuery('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSelectLocal = () => {
    setDraftWorkspace({ kind: 'local' });
    setWorktreeOpen(false);
  };

  const handleSelectWorktree = () => {
    setDraftWorkspace({ kind: 'worktree', baseRef: null });
    setWorktreeOpen(false);
  };

  const handleSelectExistingWorktree = (path: string) => {
    setDraftWorkspace({ kind: 'existing', worktreePath: path });
    setWorktreeOpen(false);
  };

  const handleSelectBaseBranch = (branchName: string) => {
    setDraftWorkspace({ kind: 'worktree', baseRef: branchName });
    setBranchOpen(false);
  };

  // 上下文条里的 chip：**无边框、无底色**，靠悬停才浮出底 —— 这是 Codex 的做法。
  // 三个 chip（项目 / 工作树 / 分支）共用这一整条，不再各带一个边框。
  // 悬停用 ink 的 alpha（`bg-foreground/8`）而不是 `--surface-3`：这条自带凹面底，
  // 而 `--surface-3` 与凹面同档（浅色 240 vs 242），悬停会看不出来。
  const chipClass = 'inline-flex h-7 max-w-44 items-center gap-1.5 rounded-md px-2 text-sm text-foreground transition-colors duration-fast hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45';

  const isLocalSelected = draftWorkspace.kind === 'local';
  const isWorktreeSelected = draftWorkspace.kind === 'worktree';

  return (
    <div
      className={cn(
        // 上下文条是**发送框顶部贴着的那一条**（Codex 的 composer rail）：
        //
        //   · 与输入框同宽同列，但**左右各内缩一个输入框圆角**（`mx-[var(--radius-xl)]`），
        //     因为输入框自己的顶角是圆的 —— 内缩量正好等于圆角半径时，rail 的两条竖边
        //     与输入框顶角弧线的终点接上，外轮廓连成一条（Codex 的
        //     `--home-composer-inline-inset` 与它的 composer 圆角同为 12px）。
        //   · 只圆上面两角、下面两角是直角，直接压在输入框顶边上，中间没有缝也没有线。
        //   · 底色 `--composer-action-bar-bg`（Codex 的 `background-composer-action-bar`）：
        //     比输入框退档、也比页面底色低一档，读作「凹进页面里的一条」。
        //   · `relative z-10` 是为了压住输入框那条 `shadow-elevation-prominent` 描边 ——
        //     描边画在输入框盒子**外**（顶边上就是 1px 的线），rail 不抬层的话
        //     接缝处会多出一条横线。
        //   · 宽度靠父级 flex 列的 `align-items: stretch` 撑开（不写 `w-full` ——
        //     那会连同左右外边距一起算 100%，比输入框宽出两个圆角）。
        'relative z-10 mx-[var(--radius-xl)] flex flex-wrap items-center gap-1 rounded-t-xl bg-[hsl(var(--composer-action-bar-bg))] px-1.5 py-1.5',
        className,
      )}
      data-testid="draft-workspace-toolbar"
      data-composer-rail
    >
      <Popover open={projectOpen} onOpenChange={setProjectOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={chipClass} data-testid="draft-project-picker">
            {draftProject ? (
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{getProjectLabel(draftProject)}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 rounded-xl border-border/70 bg-popover/98 p-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/65" />
            <Input
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              placeholder="搜索工作区"
              aria-label="搜索工作区"
              className="h-8 rounded-lg pl-8 text-xs"
              autoFocus
            />
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto">
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  setDraftProjectId(project.id);
                  setProjectOpen(false);
                  setProjectQuery('');
                }}
className={cn(
                  "option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82",
                  project.id === draftProjectId && 'option-row-selected',
                )}
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.id === draftProjectId ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-border/45 pt-1">
            {canPickDirectory && (
              <button
                type="button"
                onClick={() => void handleOpenFolder()}
                className="option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82"
              >
                <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
                <span>打开文件夹</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDraftProjectId(null);
                setProjectOpen(false);
                setProjectQuery('');
              }}
              className="option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82"
            >
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
              <span>不在项目中工作</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {draftProject ? (
        <>
          <Popover open={worktreeOpen} onOpenChange={setWorktreeOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={chipClass} data-testid="draft-worktree-picker">
                {isWorktreeSelected ? (
                  <GitBranchPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{worktreeTriggerLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 rounded-xl border-border/70 bg-popover/98 p-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/65" />
                <Input placeholder="搜索..." aria-label="搜索 worktree" className="h-8 rounded-lg pl-8 text-xs" />
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto">
                <button
                  type="button"
                  onClick={handleSelectLocal}
                  className={cn(
                  "option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82",
                  isLocalSelected && "option-row-selected",
                )}
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">本地</span>
                  {isLocalSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </button>
                <button
                  type="button"
                  data-testid="draft-worktree-create-option"
                  onClick={handleSelectWorktree}
                  disabled={!gitAvailable}
                  className={cn(
                  "option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 disabled:cursor-not-allowed disabled:opacity-55",
                  isWorktreeSelected && "option-row-selected",
                )}
                >
                  <GitBranchPlus className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">新建工作树</span>
                  {isWorktreeSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </button>
                {worktrees.filter((entry) => !entry.isMain).map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleSelectExistingWorktree(entry.path)}
                    className={cn(
                    "option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82",
                    draftWorkspace.kind === 'existing' &&
                      draftWorkspace.worktreePath === entry.path &&
                      'option-row-selected',
                  )}
                  >
                    <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                    <TooltipHint content={entry.path}>
                      <span className="min-w-0 flex-1 truncate">{entry.branch ?? entry.path}</span>
                    </TooltipHint>
                    {draftWorkspace.kind === 'existing' && draftWorkspace.worktreePath === entry.path
                      ? <Check className="h-3.5 w-3.5 text-primary" />
                      : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          {isWorktreeMode ? (
            <Popover open={branchOpen} onOpenChange={setBranchOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={chipClass} data-testid="draft-branch-picker">
                  <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{branchPickerLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 rounded-xl border-border/70 bg-popover/98 p-1.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/65" />
                  <Input
                    value={branchQuery}
                    onChange={(event) => setBranchQuery(event.target.value)}
                    placeholder="搜索分支和 PR"
                    aria-label="搜索分支和 PR"
                    className="h-8 rounded-lg pl-8 text-xs"
                    autoFocus
                  />
                </div>
                <div className="mt-2 max-h-56 overflow-y-auto">
                  {filteredBranches.map((branch) => {
                    const isSelected = branch.name === worktreeBaseRef
                      || (!worktreeBaseRef && branch.name === repositoryState?.currentBranch);
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        data-testid={`draft-branch-option-${branch.name.replace(/\//g, '--')}`}
                        onClick={() => handleSelectBaseBranch(branch.name)}
                        className={cn(
                          "option-row option-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82",
                          isSelected && "option-row-selected",
                        )}
                      >
                        <GitBranch className={cn(
                          'h-3.5 w-3.5',
                          isSelected ? 'text-primary' : 'text-muted-foreground',
                        )} />
                        <TooltipHint content={branch.name}>
                          <span className={cn(
                            'min-w-0 flex-1 truncate',
                            isSelected && 'font-medium text-primary',
                          )}>
                            {branch.name}
                          </span>
                        </TooltipHint>
                        {isSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
