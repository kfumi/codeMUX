import { Session } from '../../types/session';
import { Button } from '../ui/button';
import { Trash2, MessageSquare } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onClick, onDelete }: SessionItemProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer hover:bg-accent group',
        isActive && 'bg-accent'
      )}
      onClick={onClick}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{session.title || '未命名对话'}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
