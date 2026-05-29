import { useState } from 'react';
import { Session } from '../../types/session';
import { Project } from '../../types/project';
import { SessionItem } from './SessionItem';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Folder, ChevronRight, MoreHorizontal, Pencil, Trash2, MessageSquarePlus } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ProjectGroupProps {
  project: Project;
  sessions: Session[];
  activeSessionId: string | null;
  isActiveProject: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
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
  onDeleteSession,
  onNewSessionInProject,
  onDeleteProject,
  onRenameProject,
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
          'flex items-center gap-2 px-2.5 py-[7px] rounded-md cursor-pointer transition-all duration-200 group',
          'text-[hsl(var(--sidebar-fg))]/70',
          'hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))]',
          isActiveProject && 'bg-[hsl(var(--sidebar-accent))]/50'
        )}
        onClick={() => !renaming && setExpanded(!expanded)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[hsl(var(--sidebar-fg))]/60 transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
        <Folder className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors duration-200',
          isActiveProject ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/50'
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
            className="flex-1 text-[13px] bg-[hsl(var(--sidebar-muted))] border border-[hsl(var(--sidebar-border))] px-1.5 py-0.5 rounded text-[hsl(var(--sidebar-fg))] outline-none focus:border-[hsl(var(--sidebar-glow))]/30"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-[13px] font-medium">{project.name}</span>
        )}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu
            trigger={
              <Button variant="ghost" size="icon" className="h-5 w-5 hover:bg-black/[0.06] dark:hover:bg-white/[0.06]">
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            }
            align="right"
          >
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
              icon={<Trash2 className="h-4.5 w-4.5" />}
              danger
              onClick={() => setConfirmOpen(true)}
            >
              移除
            </DropdownMenuItem>
          </DropdownMenu>
          <button
            className="p-1 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[hsl(var(--sidebar-fg))]/60 hover:text-[hsl(var(--sidebar-glow))] transition-all duration-200"
            title={`在 ${project.name} 中开始对话`}
            onClick={() => onNewSessionInProject(project.id)}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="ml-4 pl-2.5 border-l border-[hsl(var(--sidebar-border))]">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
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
