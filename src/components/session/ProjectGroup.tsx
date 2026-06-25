import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, Folder, FolderOpen, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import { Session } from '../../types/session';
import { Project } from '../../types/project';
import { SessionItem } from './SessionItem';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';

interface ProjectGroupProps {
  project: Project;
  sessions: Session[];
  activeSessionId: string | null;
  isActiveProject: boolean;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, newName: string) => void;
  menuSessionId: string | null;
  onOpenMenu: (sessionId: string) => void;
  onCloseMenu: () => void;
}

export function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  isActiveProject,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  onRenameSession,
  onNewSessionInProject,
  onDeleteProject,
  onRenameProject,
  menuSessionId,
  onOpenMenu,
  onCloseMenu,
}: ProjectGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRename = () => {
    if (renameValue.trim() && renameValue !== project.name) {
      onRenameProject(project.id, renameValue.trim());
    }
    setRenaming(false);
  };

  return (
    <div className="mb-1">
      <div
        className={cn(
          'group relative flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2.5 py-2 transition-colors duration-150',
          'text-[hsl(var(--sidebar-fg))]/82 hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]',
          'dark:hover:border-[hsl(var(--sidebar-glow))]/14 dark:hover:bg-[hsl(var(--surface-3))]/74',
          isActiveProject && 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--sidebar-fg))] dark:border-[hsl(var(--sidebar-border))]/70 dark:bg-[hsl(var(--foreground)/0.09)]',
        )}
        onClick={() => !renaming && setExpanded(!expanded)}
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
          <DropdownMenu
            trigger={(
              <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-[hsl(var(--sidebar-fg))]/55 hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--sidebar-fg))]">
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            )}
            align="right"
          >
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
              onClick={() => setConfirmOpen(true)}
            >
              移除
            </DropdownMenuItem>
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
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
              onArchive={() => onArchiveSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onRename={(title) => onRenameSession(session.id, title)}
              isMenuOpen={menuSessionId === session.id}
              onOpenMenu={() => onOpenMenu(session.id)}
              onCloseMenu={onCloseMenu}
            />
          ))}
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
