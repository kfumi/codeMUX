import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, ChevronRight, ChevronUp, Folder, FolderOpen, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import { Session } from '../../types/session';
import { Project } from '../../types/project';
import { useProjectStore } from '../../stores/projectStore';
import { SessionItem } from './SessionItem';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';

const INITIAL_VISIBLE_PROJECT_SESSIONS = 5;
const FIRST_EXPANDED_PROJECT_SESSIONS = 15;
const PROJECT_SESSION_EXPAND_STEP = 10;

interface ProjectGroupProps {
  project: Project;
  sessions: Session[];
  activeSessionId: string | null;
  isActiveProject: boolean;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onToggleSessionPinned: (sessionId: string, pinned: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, newName: string) => void;
}

export function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  isActiveProject,
  onSelectSession,
  onArchiveSession,
  onToggleSessionPinned,
  onDeleteSession,
  onRenameSession,
  onNewSessionInProject,
  onDeleteProject,
  onRenameProject,
}: ProjectGroupProps) {
  const collapsedProjects = useProjectStore((state) => state.collapsedProjects);
  const toggleProjectExpanded = useProjectStore((state) => state.toggleProjectExpanded);
  const expanded = !collapsedProjects.has(project.id);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [visibleSessionLimit, setVisibleSessionLimit] = useState(INITIAL_VISIBLE_PROJECT_SESSIONS);
  const visibleSessions = sessions.slice(0, visibleSessionLimit);
  const hasHiddenSessions = visibleSessionLimit < sessions.length;
  const canCollapseSessions = sessions.length > INITIAL_VISIBLE_PROJECT_SESSIONS
    && visibleSessionLimit > INITIAL_VISIBLE_PROJECT_SESSIONS;

  const handleRename = () => {
    if (renameValue.trim() && renameValue !== project.name) {
      onRenameProject(project.id, renameValue.trim());
    }
    setRenaming(false);
  };

  const handleExpandSessions = () => {
    setVisibleSessionLimit((current) => {
      const next = current <= INITIAL_VISIBLE_PROJECT_SESSIONS
        ? FIRST_EXPANDED_PROJECT_SESSIONS
        : current + PROJECT_SESSION_EXPAND_STEP;
      return Math.min(next, sessions.length);
    });
  };

  const handleCollapseSessions = () => {
    setVisibleSessionLimit(INITIAL_VISIBLE_PROJECT_SESSIONS);
  };

  return (
    <div className="mb-1">
      <div
        className={cn(
          'group relative flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2.5 py-1 transition-colors duration-150',
          'text-[hsl(var(--sidebar-fg))]/82 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]',
          'dark:hover:border-[hsl(var(--sidebar-glow))]/14 dark:hover:bg-[hsl(var(--surface-3))]/74',
          isActiveProject && 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--sidebar-fg))] dark:border-[hsl(var(--sidebar-border))]/70 dark:bg-[hsl(var(--foreground)/0.09)]',
        )}
        onClick={() => !renaming && toggleProjectExpanded(project.id)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/64 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
        <Folder className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors duration-200',
          isActiveProject ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64',
        )} />
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={handleRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleRename();
              if (event.key === 'Escape') setRenaming(false);
            }}
            className="flex-1 rounded-md border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-muted))] px-2 py-1 text-[13px] text-[hsl(var(--sidebar-fg))] outline-none transition-colors focus:border-[hsl(var(--sidebar-glow))]/35"
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-[13px] font-medium">{project.name}</span>
        )}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100" onClick={(event) => event.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-[hsl(var(--sidebar-fg))]/55 hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]">
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                onClick={() => invoke('open_in_explorer', { path: project.path })}
              >
                在资源管理器中打开
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => {
                  setRenameValue(project.name);
                  setRenaming(true);
                }}
              >
                重命名项目
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                danger
                onClick={() => window.setTimeout(() => setConfirmOpen(true), 0)}
              >
                移除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/45 transition-all duration-200 hover:bg-[hsl(var(--sidebar-glow)/0.06)] hover:text-[hsl(var(--sidebar-glow))]"
                onClick={() => onNewSessionInProject(project.id)}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>在此项目中创建对话</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
      {expanded && (
        <div className="ml-4 mt-1 space-y-0.5 border-l border-[hsl(var(--sidebar-border))]/45 pl-2.5">
          {visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
              onTogglePinned={(pinned) => onToggleSessionPinned(session.id, pinned)}
              onArchive={() => onArchiveSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onRename={(title) => onRenameSession(session.id, title)}
            />
          ))}
          {(hasHiddenSessions || canCollapseSessions) && (
            <div className="flex items-center gap-1.5 pt-1">
              {hasHiddenSessions && (
                <button
                  type="button"
                  aria-label={`展开显示项目 ${project.name} 的更多对话`}
                  onClick={handleExpandSessions}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[hsl(var(--sidebar-fg))]/52 transition-colors hover:bg-[hsl(var(--sidebar-muted))]/72 hover:text-[hsl(var(--sidebar-fg))]/82"
                >
                  <ChevronDown className="h-3 w-3" />
                  展开显示
                </button>
              )}
              {canCollapseSessions && (
                <button
                  type="button"
                  aria-label={`折叠显示项目 ${project.name} 的对话`}
                  onClick={handleCollapseSessions}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[hsl(var(--sidebar-fg))]/52 transition-colors hover:bg-[hsl(var(--sidebar-muted))]/72 hover:text-[hsl(var(--sidebar-fg))]/82"
                >
                  <ChevronUp className="h-3 w-3" />
                  折叠显示
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="移除项目"
        description={`确定要移除“${project.name}”吗？项目下的对话不会被删除。`}
        confirmLabel="移除"
        variant="destructive"
        onConfirm={() => onDeleteProject(project.id)}
      />
    </div>
  );
}
