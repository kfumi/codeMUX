
import { cn } from '../../lib/utils';
import type { WorkTask } from '../../types/workTask';
import { StatusChip } from './StatusChip';
import { TaskActions } from './TaskActions';
import { formatRelativeTime } from './relativeTime';

interface TaskCardProps {
  task: WorkTask;
  projectName?: string | null;
  onOpen: (task: WorkTask) => void;
  onEdit: (task: WorkTask) => void;
  onOpenSession: (task: WorkTask) => void;
  draggable?: boolean;
  isDragged?: boolean;
  isDragOver?: boolean;
  onDragStart?: (task: WorkTask) => void;
  onDragEnd?: () => void;
  onDragOver?: (task: WorkTask) => void;
  onDrop?: (task: WorkTask) => void;
}

export function TaskCard({
  task,
  projectName,
  onOpen,
  onEdit,
  onOpenSession,
  draggable = false,
  isDragged = false,
  isDragOver = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TaskCardProps) {
  const interrupted = task.failureReason === 'interrupted';
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable || undefined}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        // 自定义类型区分语义：拖拽的是工作台任务 id（跨列拖拽 → 启动）。
        event.dataTransfer.setData('text/worktask-id', task.id);
        event.dataTransfer.setData('text/plain', task.id);
        onDragStart?.(task);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver?.(task);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop?.(task);
      }}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(task);
        }
      }}
      className={cn(
        'block w-full rounded-xl border border-border/70 bg-card p-3 text-left shadow-none transition-colors duration-fast hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
        draggable && 'cursor-grab',
        isDragged && 'opacity-50',
        isDragOver && 'border-primary ring-1 ring-primary/40',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 break-all text-ui-body font-medium text-foreground">
          {task.title}
        </span>
        <StatusChip status={task.status} />
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 text-ui-caption text-muted-foreground">
        {projectName && <span className="truncate">{projectName}</span>}
        {projectName && <span aria-hidden>·</span>}
        <span>{formatRelativeTime(task.updatedAt)}</span>
        {interrupted && <span className="text-warning">已中断</span>}
      </div>

      {(task.additions !== null || task.deletions !== null) && (
        <div className="mt-1.5 flex items-center gap-2 font-mono text-code text-muted-foreground">
          {task.additions !== null && task.additions > 0 && (
            <span className="text-success">+{task.additions}</span>
          )}
          {task.deletions !== null && task.deletions > 0 && (
            <span className="text-destructive">-{task.deletions}</span>
          )}
          {task.filesChanged !== null && task.filesChanged > 0 && (
            <span>{task.filesChanged} 个文件</span>
          )}
        </div>
      )}

      {task.status === 'review' && task.resultSummary && (
        <p className="mt-1.5 line-clamp-2 text-ui-caption text-muted-foreground">
          {task.resultSummary}
        </p>
      )}

      {task.status === 'failed' && task.lastError && (
        <p className="mt-1.5 line-clamp-2 rounded-md bg-destructive/10 px-2 py-1 text-ui-caption text-destructive">
          {task.lastError}
        </p>
      )}

      <div className="mt-2">
        <TaskActions
          task={task}
          onEdit={onEdit}
          onOpenSession={onOpenSession}
          layout="card"
        />
      </div>
    </div>
  );
}

