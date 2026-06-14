import { useState } from 'react';
import { Session } from '../../types/session';
import { Project } from '../../types/project';
import { SessionItem } from './SessionItem';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Folder, ChevronRight, MoreHorizontal, Pencil, Trash2, MessageSquarePlus, FolderOpen } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '../../lib/utils';

interface ProjectGroupProps {
  project: Project;
  sessions: Session[];
  activeSessionId: string | null;
  isActiveProject: boolean;
  onSelectSession: (sessionId: string) => void;
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
    <div className="mb-0.5">
      <div
        className={cn(
          'flex items-center gap-2 px-2.5 py-[7px] rounded-lg cursor-pointer transition-all duration-200 group relative',
          'text-[hsl(var(--sidebar-fg))]/82',
          'hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))]',
          isActiveProject && 'bg-[hsl(var(--sidebar-accent))]/50'
        )}
        onClick={() => !renaming && setExpanded(!expanded)}
      >
        {/* Active indicator for project */}
        {isActiveProject && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-[hsl(var(--sidebar-glow))] opacity-60" />
        )}
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/64 transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
        <Folder className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors duration-200',
          isActiveProject ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64'
        )} />
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="flex-1 text-[13px] bg-[hsl(var(--sidebar-muted))] border border-[hsl(var(--sidebar-border))] px-1.5 py-0.5 rounded-md text-[hsl(var(--sidebar-fg))] outline-none focus:border-[hsl(var(--sidebar-glow))]/30 transition-colors"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-[13px] font-medium">{project.name}</span>
        )}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-200" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu
            trigger={
              <Button variant="ghost" size="icon" className="h-5 w-5 hover:bg-[hsl(var(--sidebar-accent))]">
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            }
            align="right"
          >
            <DropdownMenuItem
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              onClick={() => invoke('open_in_explorer', { path: project.path })}
            >
              在文件资源管理器打开
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
                className="p-1 rounded-md hover:bg-[hsl(var(--sidebar-glow)/0.08)] text-[hsl(var(--sidebar-fg))]/40 hover:text-[hsl(var(--sidebar-glow))] transition-all duration-200"
                onClick={() => onNewSessionInProject(project.id)}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>在 {project.name} 中开始对话</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
      {expanded && (
        <div className="ml-4 pl-2.5 border-l border-[hsl(var(--sidebar-border))]/60">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
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
        description={`确定要移除「${project.name}」吗？项目下的对话不会被删除。`}
        confirmLabel="移除"
        variant="destructive"
        onConfirm={() => onDeleteProject(project.id)}
      />
    </div>
  );
}
