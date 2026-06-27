import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Loader2, Pencil, Trash2, Undo2 } from 'lucide-react';

import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { cn } from '../../lib/utils';
import { getAgentDefinition, type AgentDefinition } from '../../types/agentRegistry';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types/session';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archiveLabel?: string;
  archiveIcon?: 'archive' | 'unarchive';
  onRename: (title: string) => void;
  isMenuOpen: boolean;
  onOpenMenu: (x: number, y: number) => void;
  onCloseMenu: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分`;
  if (diffHour < 24) return `${diffHour}时`;
  if (diffMonth < 12) return `${diffDay}天`;
  if (diffYear < 1) return `${diffMonth}月`;
  return `${diffYear}年`;
}

function SessionStatusIcon({
  session,
  isActive,
  agentDef,
}: {
  session: Session;
  isActive: boolean;
  agentDef: AgentDefinition | undefined;
}) {
  const isRunning = useAgentStore((s) => s.isRunning[session.id] ?? false);
  const hasError = useAgentStore((s) => !!s.error[session.id]);
  const isUnread = useSessionStore((s) => s.unreadSessions.has(session.id));

  if (isRunning) {
    return (
      <span className="flex shrink-0 items-center justify-center h-4 w-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--accent))]" />
      </span>
    );
  }

  if (hasError) {
    return (
      <span className="flex shrink-0 items-center justify-center h-4 w-4">
        <span className="h-2 w-2 rounded-full bg-[hsl(var(--destructive))]" />
      </span>
    );
  }

  if (isUnread) {
    return (
      <span className="flex shrink-0 items-center justify-center h-4 w-4">
        <span className="h-2 w-2 rounded-full bg-[hsl(var(--success))]" />
      </span>
    );
  }

  if (agentDef) {
    return (
      <span className={cn('flex shrink-0 items-center transition-opacity duration-200', isActive ? 'opacity-100' : 'opacity-70')}>
        <AgentBrandIcon agent={agentDef} size="sm" />
      </span>
    );
  }

  return (
    <span className={cn('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold tracking-normal', isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64')}>
      {session.agent_kind?.slice(0, 2).toUpperCase() || '??'}
    </span>
  );
}

export function SessionItem({
  session,
  isActive,
  onClick,
  onArchive,
  onDelete,
  archiveLabel = '归档',
  archiveIcon = 'archive',
  onRename,
  isMenuOpen,
  onOpenMenu,
  onCloseMenu,
}: SessionItemProps) {
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const agentDef = getAgentDefinition(session.agent_kind);
  const timeLabel = formatRelativeTime(session.updated_at);
  const ArchiveIcon = archiveIcon === 'archive' ? Archive : Undo2;

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPos({ x: event.clientX, y: event.clientY });
    onOpenMenu(event.clientX, event.clientY);
  }, [onOpenMenu]);

  const handleRenameStart = () => {
    setRenameValue(session.title || '');
    setRenaming(true);
    onCloseMenu();
  };

  const handleRenameCommit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    }
    setRenaming(false);
  };

  const handleArchive = () => {
    onCloseMenu();
    onArchive();
  };

  const handleDelete = () => {
    onCloseMenu();
    setConfirmOpen(true);
  };

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center gap-2.5 rounded-md border border-transparent px-2.5 py-1 text-[13px] transition-colors duration-150',
          'cursor-pointer text-[hsl(var(--sidebar-fg))]/80',
          'hover:bg-[hsl(var(--sidebar-muted))]/78 hover:text-[hsl(var(--sidebar-fg))]',
          'dark:hover:border-[hsl(var(--sidebar-glow))]/14 dark:hover:bg-[hsl(var(--surface-3))]/74',
          isActive && 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--sidebar-fg))] dark:border-[hsl(var(--sidebar-border))]/70 dark:bg-[hsl(var(--foreground)/0.105)]',
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        <SessionStatusIcon session={session} isActive={isActive} agentDef={agentDef} />

        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={handleRenameCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleRenameCommit();
              if (event.key === 'Escape') setRenaming(false);
            }}
            onClick={(event) => event.stopPropagation()}
            className="flex-1 min-w-0 rounded-md border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-muted))] px-2 py-1 text-[13px] text-[hsl(var(--sidebar-fg))] outline-none transition-colors focus:border-[hsl(var(--sidebar-glow))]/35"
          />
        ) : (
          <>
            <span className={cn('flex-1 truncate transition-colors duration-200', isActive && 'font-medium')}>
              {session.title || '未命名对话'}
            </span>
            <span className="relative shrink-0 h-5">
              <span className={cn('inline-flex items-center text-[12px] tabular-nums transition-opacity duration-150', 'text-[hsl(var(--sidebar-fg))]/40', 'group-hover:opacity-0')}>
                {timeLabel}
              </span>
              <button
                className={cn(
                  'absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 transition-opacity duration-150',
                  'text-[hsl(var(--sidebar-fg))]/42 opacity-0 group-hover:opacity-100',
                  'hover:bg-[hsl(var(--sidebar-bg))] hover:text-[hsl(var(--sidebar-fg))]',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  handleArchive();
                }}
              >
                <ArchiveIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          </>
        )}
      </div>

      {isMenuOpen && createPortal(
        <div
          className="surface-panel fixed z-180 min-w-35 rounded-xl border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_48px_-28px_hsl(var(--foreground)/0.38),0_0_0_1px_hsl(var(--background)/0.68)] backdrop-blur-md animate-in fade-in blur-in-4 fill-mode-both animation-duration-[180ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.98,hsl(var(--surface-1))/0.95)] dark:shadow-[0_24px_64px_-34px_hsl(var(--surface-shadow-strong)/0.98),0_0_0_1px_hsl(var(--foreground)/0.04)]"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-foreground/82 transition-colors hover:bg-muted/72 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.9]"
            onClick={handleRenameStart}
          >
            <Pencil className="h-3.5 w-3.5" />
            重命名
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-foreground/82 transition-colors hover:bg-muted/72 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.9]"
            onClick={handleArchive}
          >
            <ArchiveIcon className="h-3.5 w-3.5" />
            {archiveLabel}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-destructive transition-colors hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive"
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除对话"
        description={`确定要删除“${session.title || '未命名对话'}”吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={onDelete}
      />
    </>
  );
}
