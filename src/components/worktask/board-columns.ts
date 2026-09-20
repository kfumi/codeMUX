import type { WorkTask, WorkTaskStatus } from '../../types/workTask';

export type WorkTaskColumnId = 'todo' | 'inProgress' | 'attention' | 'done';

/** 看板四列的稳定顺序。 */
export const BOARD_COLUMN_IDS: WorkTaskColumnId[] = ['todo', 'inProgress', 'attention', 'done'];

/** 每列覆盖的状态集合：并集必须恰好是全部 10 个状态（见 board-columns.test.ts 守卫）。 */
export const STATUSES_BY_COLUMN: Record<WorkTaskColumnId, WorkTaskStatus[]> = {
  todo: ['todo', 'queued'],
  inProgress: ['preparing', 'running'],
  attention: ['awaiting_input', 'review', 'merging', 'failed'],
  done: ['done', 'canceled'],
};

const COLUMN_BY_STATUS = new Map<WorkTaskStatus, WorkTaskColumnId>(
  (Object.entries(STATUSES_BY_COLUMN) as [WorkTaskColumnId, WorkTaskStatus[]][])
    .flatMap(([column, statuses]) => statuses.map((status) => [status, column] as const)),
);

export function columnForStatus(status: WorkTaskStatus): WorkTaskColumnId {
  return COLUMN_BY_STATUS.get(status) ?? 'todo';
}

/** done 列在关闭「显示已取消」时仍然展示 done。 */
function isCanceledVisible(task: WorkTask, showCanceled: boolean): boolean {
  return task.status !== 'canceled' || showCanceled;
}

export function isArchived(task: WorkTask): boolean {
  return task.archivedAt !== null;
}

/** 通用可见性过滤：已归档 / 已取消的显隐由外部开关控制。column 传 null 表示不过滤列。 */
export function filterTasksForList(
  tasks: WorkTask[],
  column: WorkTaskColumnId | null,
  showCanceled: boolean,
  showArchived: boolean,
): WorkTask[] {
  const statuses = column ? new Set(STATUSES_BY_COLUMN[column]) : null;
  return tasks.filter((task) => {
    if (!showArchived && task.archivedAt) return false;
    if (!isCanceledVisible(task, showCanceled)) return false;
    if (statuses && !statuses.has(task.status)) return false;
    return true;
  });
}

/** 按看板列分组，每列内按 updatedAt 降序（最新在上）。 */
export function groupTasksByColumn(
  tasks: WorkTask[],
  showCanceled: boolean,
  showArchived: boolean,
): Record<WorkTaskColumnId, WorkTask[]> {
  const grouped: Record<WorkTaskColumnId, WorkTask[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  };
  for (const task of tasks) {
    if (!showArchived && task.archivedAt) continue;
    if (!isCanceledVisible(task, showCanceled)) continue;
    grouped[columnForStatus(task.status)].push(task);
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }
  return grouped;
}

/**
 * 列内展示排序：待办列在选中单一项目时按 sortOrder 升序（排序拖拽即按此展示），
 * 其余情况按 updatedAt 降序。
 */
export function sortTasksForDisplay(
  tasks: WorkTask[],
  column: WorkTaskColumnId,
  projectId: string | null,
): WorkTask[] {
  if (column === 'todo' && projectId) {
    return [...tasks].sort((left, right) => left.sortOrder - right.sortOrder);
  }
  return [...tasks].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}
