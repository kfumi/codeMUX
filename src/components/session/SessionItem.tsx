import { useState } from 'react';
import { Session } from '../../types/session';
import { Trash2, MessageSquare } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onClick, onDelete }: SessionItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-2.5 px-2.5 py-[7px] rounded-md cursor-pointer transition-all duration-200 text-[13px]',
          'text-[hsl(var(--sidebar-fg))]/70',
          'hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))]',
          isActive && [
            'bg-[hsl(var(--sidebar-accent))]',
            'text-[hsl(var(--sidebar-fg))]',
            'shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border))]'
          ]
        )}
        onClick={onClick}
      >
        <MessageSquare className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors duration-200',
          isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/50'
        )} />
        <span className="flex-1 truncate">{session.title || '未命名对话'}</span>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[hsl(var(--sidebar-fg))]/60 hover:text-[hsl(var(--sidebar-fg))] transition-all duration-200"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(true);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除对话"
        description={`确定要删除「${session.title || '未命名对话'}」吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={onDelete}
      />
    </>
  );
}
