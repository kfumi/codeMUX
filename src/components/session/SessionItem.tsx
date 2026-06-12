import { useState } from 'react';
import { Trash2 } from 'lucide-react';

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
}

export function SessionItem({ session, isActive, onClick, onDelete }: SessionItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const agentDef = getAgentDefinition(session.agent_kind);

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-all duration-200',
          'cursor-pointer text-[hsl(var(--sidebar-fg))]/82',
          'hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-fg))]',
          isActive && ['bg-[hsl(var(--sidebar-accent))]', 'text-[hsl(var(--sidebar-fg))]'],
        )}
        onClick={onClick}
      >
        {isActive && (
          <div className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[hsl(var(--sidebar-glow))] opacity-80" />
        )}
        {agentDef ? (
          <span className={cn('shrink-0 transition-opacity duration-200', isActive ? 'opacity-100' : 'opacity-64')}>
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
        <span className={cn('flex-1 truncate transition-colors duration-200', isActive && 'font-medium')}>
          {session.title || '未命名对话'}
        </span>
        <button
          className="rounded-md p-1 text-[hsl(var(--sidebar-fg))]/68 opacity-0 transition-all duration-200 hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))] group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
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
