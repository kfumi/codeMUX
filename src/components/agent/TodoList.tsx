import { useState } from 'react';
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import type { TodoItem } from '../../types/agent';

interface TodoListProps {
  todos: TodoItem[];
  className?: string;
}

function getStatusIcon(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return <span className="text-green-500 text-xs shrink-0">✓</span>;
    case 'in_progress':
      return (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
        </span>
      );
    case 'pending':
      return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />;
  }
}

export function TodoList({ todos, className }: TodoListProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={`border border-border/40 rounded-lg bg-muted/20 overflow-hidden ${className ?? ''}`}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/30 transition-colors text-left"
      >
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground/80">任务进度</span>
        <span className="text-xs text-muted-foreground/60 ml-auto shrink-0 tabular-nums"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {completed}/{total}
        </span>
      </button>

      {/* Progress bar */}
      <div className="px-3 pb-1">
        <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
          <div
            className="h-full rounded-full bg-green-500/70 transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Todo list */}
      {isExpanded && (
        <div className="px-3 pb-2.5 space-y-1 stagger-children">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2 py-1 text-xs leading-relaxed">
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
      )}
    </div>
  );
}
