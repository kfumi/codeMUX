import { ListTodo } from 'lucide-react';
import type { TodoItem } from '../../types/agent';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface TodoListProps {
  todos: TodoItem[];
  className?: string;
  dropdownSide?: 'up' | 'down';
  align?: 'left' | 'right';
}

function getStatusIcon(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 5.5 4 7.5 8 3" />
          </svg>
        </span>
      );
    case 'in_progress':
      return (
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-[hsl(var(--warning)/0.4)]" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[hsl(var(--warning))]" />
        </span>
      );
    case 'pending':
      return <span className="h-2 w-2 rounded-full bg-muted-foreground/20" />;
  }
}

export function TodoList({ todos, className, dropdownSide = 'up', align = 'left' }: TodoListProps) {
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const progressPct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={className}>
      <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border/45 bg-[hsl(var(--card))]/65 hover:bg-muted/40 transition-all duration-200 text-left">
          <ListTodo className="h-3.5 w-3.5 text-[hsl(var(--primary)/0.5)] shrink-0" />
          <span className="text-xs font-medium text-foreground/70">任务</span>
          <span className="text-xs text-muted-foreground/50 tabular-nums ml-auto"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {completed}/{total}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={dropdownSide === 'up' ? 'top' : 'bottom'}
        sideOffset={8}
        align={align === 'left' ? 'start' : 'end'}
        className={'w-85 max-h-75 overflow-auto rounded-xl border border-border/40 bg-[hsl(var(--card))] p-0 ' + (dropdownSide === 'up' ? 'shadow-[0_-4px_24px_-4px_hsl(var(--foreground)/0.06)]' : 'shadow-[0_12px_34px_-18px_hsl(var(--foreground)/0.34)]')}
      >
        <div className="px-3 py-2.5 space-y-0.5 stagger-children">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2.5 py-1.5 text-xs leading-relaxed">
              <span className="mt-0.5 shrink-0">{getStatusIcon(todo.status)}</span>
              <span className={
                todo.status === 'completed'
                  ? 'text-muted-foreground/40 line-through'
                  : todo.status === 'in_progress'
                    ? 'text-foreground/90 font-medium'
                    : 'text-foreground/60'
              }>
                {todo.status === 'in_progress' && todo.activeForm
                  ? todo.activeForm
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
        <div className="px-3 pb-2.5 pt-1">
          <div className="h-1 w-full rounded-full bg-muted/40 overflow-hidden">
            <div
              className="h-full rounded-full bg-linear-to-r from-[hsl(var(--primary)/0.6)] to-[hsl(var(--primary))] transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
    </div>
  );
}
