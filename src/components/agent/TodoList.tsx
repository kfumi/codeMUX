import { useState } from 'react';
import { ChevronUp, ChevronDown, ListTodo } from 'lucide-react';
import type { TodoItem } from '../../types/agent';

interface TodoListProps {
  todos: TodoItem[];
  className?: string;
}

function getStatusIcon(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return <span className="text-green-500 text-xs leading-none mt-px">✓</span>;
    case 'in_progress':
      return (
        <span className="relative flex h-2 w-2 mt-0.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
        </span>
      );
    case 'pending':
      return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 mt-0.5" />;
  }
}

export function TodoList({ todos, className }: TodoListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Expandable list — positioned above, expands upward */}
      {isExpanded && (
        <div className="absolute bottom-full left-0 mb-1 w-[320px] max-h-[300px] overflow-auto border border-border/40 rounded-xl bg-background shadow-lg z-50 animate-fade-in-up">
          {/* Progress bar */}
          <div className="px-3 pt-3 pb-1">
            <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500/70 transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Todo list */}
          <div className="px-3 pb-2.5 space-y-0.5 stagger-children">
            {todos.map((todo, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs leading-relaxed">
                {getStatusIcon(todo.status)}
                <span className={
                  todo.status === 'completed'
                    ? 'text-muted-foreground/50 line-through'
                    : todo.status === 'in_progress'
                      ? 'text-foreground/90'
                      : 'text-foreground/70'
                }>
                  {todo.status === 'in_progress' && todo.activeForm
                    ? todo.activeForm
                    : todo.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trigger button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground/80">任务进度</span>
        <span className="text-xs text-muted-foreground/60 tabular-nums"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {completed}/{total}
        </span>
      </button>
    </div>
  );
}
