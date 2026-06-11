import { useState } from 'react';
import { Session } from '../../types/session';
import { Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { getAgentDefinition } from '../../types/agentRegistry';

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
          'group flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg cursor-pointer transition-all duration-200 text-[13px] relative',
          'text-[hsl(var(--sidebar-fg))]/82',
          'hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))]',
          isActive && [
            'bg-[hsl(var(--sidebar-accent))]',
            'text-[hsl(var(--sidebar-fg))]',
          ]
        )}
        onClick={onClick}
      >
        {/* Active indicator bar */}
        {isActive && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-[hsl(var(--sidebar-glow))] opacity-80" />
        )}
        {agentDef ? (
          <span className={cn(
            'shrink-0 transition-opacity duration-200',
            isActive ? 'opacity-100' : 'opacity-64'
          )}>
            <AgentBrandIcon agent={agentDef} size="sm" />
          </span>
        ) : (
          <span className={cn(
            'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold tracking-wider',
            isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64'
          )}>
            {session.agent_kind?.slice(0, 2).toUpperCase() || '??'}
          </span>
        )}
        <span className={cn(
          'flex-1 truncate transition-colors duration-200',
          isActive && 'font-medium'
        )}>
          {session.title || '未命名对话'}
        </span>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))] text-[hsl(var(--sidebar-fg))]/68 transition-all duration-200"
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
