import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Circle,
  Folder,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  getBranchPickerLabel,
  getWorktreeTriggerLabel,
} from '../../lib/draftWorkspacePicker';
import { gitApi, type GitRepositoryState, type GitWorktree } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { useProjectStore } from '../../stores/projectStore';
import type { Project } from '../../types/project';
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
      || project.path.toLowerCase().includes(query),
    );
  }, [projectQuery, projects]);

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
    if (!draftProject?.path) {
      setRepositoryState(null);
      setWorktrees([]);
      setGitAvailable(false);
      return;
    }

    const statePath = existingWorktreePath ?? draftProject.path;

    setGitLoading(true);
    try {
      const [state, nextWorktrees] = await Promise.all([
        gitApi.getRepositoryState(statePath),
        gitApi.listWorktrees(draftProject.path),
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
  }, [draftProject?.path, existingWorktreePath]);

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
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      });
      if (!selected) {
        return;
      }
      const path = selected as string;
      const name = path.split(/[/\\]/).pop() || path;
      const project = await createProject(name, path);
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

  const pickerButtonClass = 'inline-flex h-8 max-w-44 items-center gap-1.5 rounded-lg border border-border/55 bg-[hsl(var(--surface-2))]/72 px-2.5 text-ui-caption text-foreground/82 transition-colors hover:bg-muted/52';

  const isLocalSelected = draftWorkspace.kind === 'local';
  const isWorktreeSelected = draftWorkspace.kind === 'worktree';

  return (
    <div className={cn('mb-3 flex flex-wrap items-center gap-2', className)} data-testid="draft-workspace-toolbar">
      <Popover open={projectOpen} onOpenChange={setProjectOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={pickerButtonClass} data-testid="draft-project-picker">
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{getProjectLabel(draftProject)}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
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
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.id === draftProjectId ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-border/45 pt-1">
            <button
              type="button"
              onClick={() => void handleOpenFolder()}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
              <span>打开文件夹</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftProjectId(null);
                setProjectOpen(false);
                setProjectQuery('');
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
            >
              <Circle className="h-3.5 w-3.5 text-muted-foreground" />
              <span>不在项目中工作</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {draftProject ? (
        <>
          <Popover open={worktreeOpen} onOpenChange={setWorktreeOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={pickerButtonClass} data-testid="draft-worktree-picker">
                {isWorktreeSelected ? (
                  <GitBranchPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{worktreeTriggerLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-55"
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
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
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
                <button type="button" className={pickerButtonClass} data-testid="draft-branch-picker">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{branchPickerLabel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
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
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/82 transition-colors hover:bg-muted/55"
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
