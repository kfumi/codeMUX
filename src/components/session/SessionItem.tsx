import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2 } from 'lucide-react';

import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { cn } from '../../lib/utils';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { Session } from '../../types/session';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
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

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 30) return `${diffDay}天前`;

  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month}-${day}`;
  }
  return `${date.getFullYear()}-${month}-${day}`;
}

export function SessionItem({ session, isActive, onClick, onDelete, onRename, isMenuOpen, onOpenMenu, onCloseMenu }: SessionItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const agentDef = getAgentDefinition(session.agent_kind);

  const timeLabel = formatRelativeTime(session.updated_at);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    onOpenMenu(e.clientX, e.clientY);
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

  const handleDelete = () => {
    onCloseMenu();
    setConfirmOpen(true);
  };

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2 text-[13px] transition-all duration-200',
          'cursor-pointer text-[hsl(var(--sidebar-fg))]/80',
          'hover:border-[hsl(var(--sidebar-border))]/55 hover:bg-[hsl(var(--sidebar-muted))]/82 hover:text-[hsl(var(--sidebar-fg))]',
          'dark:hover:border-[hsl(var(--sidebar-glow))]/12 dark:hover:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.88,hsl(var(--surface-2))/0.78)]',
          isActive && 'border-[hsl(var(--sidebar-glow))]/28 bg-[hsl(var(--sidebar-glow))]/9 text-[hsl(var(--sidebar-fg))] dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.96,hsl(var(--surface-2))/0.84)] dark:shadow-[0_14px_30px_-24px_hsl(var(--surface-shadow-strong)/0.95),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_0_1px_hsl(var(--sidebar-glow)/0.08)]',
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        {isActive && (
          <div className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[hsl(var(--sidebar-glow))] opacity-80" />
        )}
        {agentDef ? (
          <span className={cn('flex shrink-0 items-center transition-opacity duration-200', isActive ? 'opacity-100' : 'opacity-70')}>
            <AgentBrandIcon agent={agentDef} size="sm" />
          </span>
        ) : (
          <span
            className={cn(
              'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold tracking-wider',
              isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64',
            )}
          >
            {session.agent_kind?.slice(0, 2).toUpperCase() || '??'}
          </span>
        )}

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
              <span className={cn(
                'inline-flex items-center text-[10px] tabular-nums transition-opacity duration-150',
                'text-[hsl(var(--sidebar-fg))]/30',
                'group-hover:opacity-0',
              )}>
                {timeLabel}
              </span>
              <button
                className={cn(
                  'absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 transition-opacity duration-150',
                  'text-[hsl(var(--sidebar-fg))]/42 opacity-0 group-hover:opacity-100',
                  'hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))]',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirmOpen(true);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </>
        )}
      </div>

      {isMenuOpen && createPortal(
        <div
          className="surface-panel fixed z-[180] min-w-[140px] rounded-lg border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_50px_-28px_hsl(var(--foreground)/0.42),0_0_0_1px_hsl(var(--background)/0.7)] backdrop-blur-md animate-in fade-in blur-in-4 fill-mode-both [animation-duration:180ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.98,hsl(var(--surface-1))/0.95)] dark:shadow-[0_24px_64px_-30px_hsl(var(--surface-shadow-strong)/0.98),0_0_0_1px_hsl(var(--foreground)/0.045)]"
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
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10"
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
