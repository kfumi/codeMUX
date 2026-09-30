import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { TodoItem } from '@/types/agent';

/**
 * 待办状态图标。三种状态按「形状 + 语义色」区分，读一列待办时可以扫读：
 * 实心对勾 = 已完成，实心圆点 = 进行中，空心圆 = 未开始。
 */
export function TodoStatusIcon({ status, className }: { status: TodoItem['status']; className?: string }) {
  if (status === 'completed') {
    return (
      <span
        data-slot="todo-status-icon"
        data-status="completed"
        className={cn('flex size-4 shrink-0 items-center justify-center rounded-full bg-success/12 text-success', className)}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    );
  }

  if (status === 'in_progress') {
    return (
      <span
        data-slot="todo-status-icon"
        data-status="in_progress"
        className={cn('flex size-4 shrink-0 items-center justify-center rounded-full bg-warning/12', className)}
      >
        <span className="size-2 rounded-full bg-warning" />
      </span>
    );
  }

  return (
    <span
      data-slot="todo-status-icon"
      data-status="pending"
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-full', className)}
    >
      <span className="size-2 rounded-full border border-muted-foreground/30" />
    </span>
  );
}
