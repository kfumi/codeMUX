import type { WorkTask } from '../../types/workTask';
import type { WorkTaskColumnId } from './board-columns';
import { filterTasksForList } from './board-columns';
import { StatusChip } from './StatusChip';
import { TaskActions } from './TaskActions';
import { formatRelativeTime } from './relativeTime';

interface TaskListViewProps {
  tasks: WorkTask[];
  column: WorkTaskColumnId | null;
  showCanceled: boolean;
  showArchived: boolean;
  projectNameById: (projectId: string) => string | null;
  onOpen: (task: WorkTask) => void;
  onEdit: (task: WorkTask) => void;
  onOpenSession: (task: WorkTask) => void;
}

/** 列表视图：行列表（状态徽章 + 标题 + 项目 + 时间 + 主动作），与看板共用过滤与动作矩阵。 */
export function TaskListView({
  tasks,
  column,
  showCanceled,
  showArchived,
  projectNameById,
  onOpen,
  onEdit,
  onOpenSession,
}: TaskListViewProps) {
  const visible = filterTasksForList(tasks, column, showCanceled, showArchived).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );

  if (visible.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <p className="text-ui-body text-muted-foreground">暂无任务</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-4">
      {visible.map((task) => (
        <div
          key={task.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(task)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(task);
            }
          }}
          className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <StatusChip status={task.status} />
          <span className="min-w-0 flex-1 truncate text-ui-body font-medium text-foreground">
            {task.title}
          </span>
          <span className="hidden shrink-0 text-ui-caption text-muted-foreground sm:inline">
            {projectNameById(task.projectId)}
          </span>
          <span className="shrink-0 text-ui-caption text-muted-foreground">
            {formatRelativeTime(task.updatedAt)}
          </span>
          <TaskActions
            task={task}
            onEdit={onEdit}
            onOpenSession={onOpenSession}
          />
        </div>
      ))}
    </div>
  );
}
