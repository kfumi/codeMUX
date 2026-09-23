import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, Filter, List, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '../../lib/utils';
import { useProjectStore } from '../../stores/projectStore';
import { useWorkTaskStore } from '../../stores/workTaskStore';
import type { WorkTask } from '../../types/workTask';
import { AutomationProjectPicker } from '../automation/AutomationProjectPicker';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { TooltipHint } from '../ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  BOARD_COLUMN_IDS,
  groupTasksByColumn,
  sortTasksForDisplay,
  type WorkTaskColumnId,
} from './board-columns';
import { TaskCard } from './TaskCard';
import { TaskDetailDialog } from './TaskDetailDialog';
import { TaskEditorDialog } from './TaskEditorDialog';
import { TaskListView } from './TaskListView';

const VIEW_MODE_KEY = 'worktask.viewMode';
const FILTERS_KEY = 'worktask.filters';
const POLL_INTERVAL_MS = 10_000;

type ViewMode = 'board' | 'list';

interface PersistedFilters {
  showCanceled: boolean;
  showArchived: boolean;
  projectId: string | null;
  /** 列表视图的状态筛选（看板列 id）；null = 全部。 */
  listColumn: WorkTaskColumnId | null;
}

const DEFAULT_FILTERS: PersistedFilters = {
  showCanceled: false,
  showArchived: false,
  projectId: null,
  listColumn: null,
};

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function loadFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    return {
      showCanceled: parsed.showCanceled === true,
      showArchived: parsed.showArchived === true,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      listColumn: parsed.listColumn != null
        && BOARD_COLUMN_IDS.includes(parsed.listColumn)
        ? parsed.listColumn
        : null,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // 忽略存储错误
  }
}

function saveFilters(filters: PersistedFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // 忽略存储错误
  }
}

const COLUMN_META: Record<WorkTaskColumnId, { title: string; barClass: string }> = {
  todo: { title: '待办', barClass: 'bg-muted-foreground/50' },
  inProgress: { title: '进行中', barClass: 'bg-primary' },
  attention: { title: '等你处理', barClass: 'bg-warning' },
  done: { title: '完成', barClass: 'bg-success' },
};

interface WorkTaskBoardProps {
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

export function WorkTaskBoard({ onOpenSession }: WorkTaskBoardProps) {
  const tasks = useWorkTaskStore((state) => state.tasks);
  const isLoading = useWorkTaskStore((state) => state.isLoading);
  const fetchTasks = useWorkTaskStore((state) => state.fetchTasks);
  const reorder = useWorkTaskStore((state) => state.reorder);
  const startTask = useWorkTaskStore((state) => state.startTask);
  const archiveAllDone = useWorkTaskStore((state) => state.archiveAllDone);
  const projects = useProjectStore((state) => state.projects);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);

  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [filters, setFilters] = useState<PersistedFilters>(loadFilters);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<WorkTask | null>(null);
  const [detailTask, setDetailTask] = useState<WorkTask | null>(null);
  const [archiveAllPending, setArchiveAllPending] = useState(false);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<WorkTaskColumnId | null>(null);
  const dragOverCardRef = useRef<string | null>(null);

  useEffect(() => {
    fetchProjects();
    void fetchTasks();
    const timer = window.setInterval(() => {
      void fetchTasks();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchProjects, fetchTasks]);

  const grouped = useMemo(
    () => groupTasksByColumn(tasks, filters.showCanceled, filters.showArchived),
    [tasks, filters.showCanceled, filters.showArchived],
  );


  // 过滤条件持久化到 localStorage（'worktask.filters'）。
  useEffect(() => {
    saveFilters(filters);
  }, [filters]);
  const projectNameById = useCallback(
    (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? null,
    [projects],
  );

  // 拖拽排序仅在「看板 + 选中单一项目」时启用（sort_order 每项目独立）。
  const reorderEnabled = viewMode === 'board' && filters.projectId != null;

  // drop 语义按目标列区分：待办列 = 列内排序，进行中列 = 启动任务，其余列不响应。
  const acceptsDrop = useCallback(
    (column: WorkTaskColumnId) =>
      (reorderEnabled && column === 'todo') || column === 'inProgress',
    [reorderEnabled],
  );

  const handleDrop = useCallback(
    (targetTask: WorkTask | null, targetColumn: WorkTaskColumnId) => {
      const projectId = filters.projectId;
      const draggedId = dragTaskId;
      setDragTaskId(null);
      setDragOverColumn(null);
      dragOverCardRef.current = null;
      if (!draggedId) return;

      // 跨列：待办卡片拖入「进行中」列 = 启动任务（store.startTask，乐观置 queued）。
      // 其他跨列组合（完成 / 等你处理 / 无项目选择时的待办列）不响应。
      if (targetColumn === 'inProgress') {
        const dragged = tasks.find((task) => task.id === draggedId);
        if (!dragged || dragged.status !== 'todo' || dragged.archivedAt) return;
        void startTask(draggedId).catch((error) => {
          toast.error('启动任务失败', {
            description: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      if (targetColumn !== 'todo' || !reorderEnabled || !projectId) return;
      if (draggedId === targetTask?.id) return;

      const columnTasks = sortTasksForDisplay(
        tasks.filter(
          (task) => task.projectId === projectId
            && task.status !== 'canceled'
            && !task.archivedAt,
        ),
        'todo',
        projectId,
      );
      const ids = columnTasks.map((task) => task.id);
      const from = ids.indexOf(draggedId);
      if (from === -1) return;
      ids.splice(from, 1);
      const to = targetTask ? ids.indexOf(targetTask.id) : ids.length;
      if (to === -1) return;
      ids.splice(to, 0, draggedId);
      void reorder(projectId, ids).catch((error) => {
        toast.error('排序保存失败', {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [filters.projectId, dragTaskId, reorder, reorderEnabled, startTask, tasks],
  );

  const handleArchiveAllDone = async () => {
    if (archiveAllPending) return;
    setArchiveAllPending(true);
    try {
      await archiveAllDone();
      toast.success('已完成任务已全部归档');
    } catch (error) {
      toast.error('归档失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setArchiveAllPending(false);
    }
  };

  const openSessionFor = useCallback(
    (task: WorkTask) => {
      if (!task.sessionId) return;
      onOpenSession(task.sessionId, task.projectId);
    },
    [onOpenSession],
  );

  const openEditorFor = useCallback((task: WorkTask) => {
    setDetailTask(null);
    setEditingTask(task);
    setEditorOpen(true);
  }, []);

  const doneColumnTasks = grouped.done.filter((task) => task.status === 'done' && !task.archivedAt);
  const canArchiveAll = doneColumnTasks.length > 0;

  const renderColumn = (column: WorkTaskColumnId) => {
    const meta = COLUMN_META[column];
    const columnTasks = sortTasksForDisplay(grouped[column], column, filters.projectId);
    const isAttention = column === 'attention';
    const isDropTarget = dragOverColumn === column && acceptsDrop(column);
    return (
      <div
        key={column}
        className={cn(
          'flex min-h-0 flex-col rounded-xl border border-border/50 bg-muted/20',
          isDropTarget && 'border-dashed border-primary bg-primary/5',
        )}
        onDragOver={(event) => {
          if (!acceptsDrop(column)) return;
          event.preventDefault();
          setDragOverColumn(column);
        }}
        onDrop={(event) => {
          event.preventDefault();
          // 落到列空白处 = 追加到末尾（排序）/ 直接命中该列语义（启动）；卡片上的 drop 会 stopPropagation。
          handleDrop(null, column);
        }}
      >
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <span className={cn('h-3.5 w-1 shrink-0 rounded-full', meta.barClass)} aria-hidden />
          <span className="text-ui-body font-medium text-foreground">{meta.title}</span>
          <span
            className={cn(
              'ml-1 rounded-full px-2 py-0.5 text-ui-caption text-muted-foreground',
              isAttention ? 'bg-warning/15 text-warning' : 'bg-muted/70',
            )}
          >
            {columnTasks.length}
          </span>
          <span className="flex-1" />
          {column === 'done' && (
            <TooltipHint content="归档所有已完成的任务">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-ui-caption"
                disabled={!canArchiveAll || archiveAllPending}
                onClick={() => void handleArchiveAllDone()}
              >
                {archiveAllPending
                  ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  : '全部归档'}
              </Button>
            </TooltipHint>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
          {columnTasks.length === 0 ? (
            <div className="mt-1 flex min-h-16 items-center justify-center rounded-lg border border-dashed border-border/60 px-3 py-4">
              <p className="text-ui-caption text-muted-foreground">暂无任务</p>
            </div>
          ) : (
            columnTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                projectName={projectNameById(task.projectId)}
                onOpen={setDetailTask}
                onEdit={openEditorFor}
                onOpenSession={openSessionFor}
                // 待办列卡片始终可拖（跨列 → 启动）；其余卡片保持原排序约束，且已取消/已归档不可拖。
                draggable={
                  column === 'todo'
                    ? (reorderEnabled || task.status === 'todo') && !task.archivedAt
                    : reorderEnabled && task.status !== 'canceled' && !task.archivedAt
                }
                isDragged={dragTaskId === task.id}
                isDragOver={acceptsDrop(column) && dragOverCardRef.current === task.id}
                onDragStart={(dragged) => setDragTaskId(dragged.id)}
                onDragEnd={() => {
                  setDragTaskId(null);
                  setDragOverColumn(null);
                  dragOverCardRef.current = null;
                }}
                onDragOver={(dragged) => {
                  if (acceptsDrop(column) && dragged.id !== dragOverCardRef.current) {
                    dragOverCardRef.current = dragged.id;
                    setDragOverColumn(column);
                  }
                }}
                onDrop={(target) => handleDrop(target, column)}
              />
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <h1 className="text-ui-title font-semibold text-foreground">待办看板</h1>
        <span className="flex-1" />
        <AutomationProjectPicker
          projects={projects}
          value={filters.projectId}
          onChange={(projectId) => setFilters((current) => ({ ...current, projectId }))}
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-ui-body">
              <Filter className="h-3.5 w-3.5" aria-hidden />
              筛选
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-2">
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-body hover:bg-muted/60">
              <input
                type="checkbox"
                className="accent-[hsl(var(--primary))]"
                checked={filters.showCanceled}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  showCanceled: event.target.checked,
                }))}
              />
              显示已取消
            </label>
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-body hover:bg-muted/60">
              <input
                type="checkbox"
                className="accent-[hsl(var(--primary))]"
                checked={filters.showArchived}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  showArchived: event.target.checked,
                }))}
              />
              显示已归档
            </label>
          </PopoverContent>
        </Popover>
        {/* 同一时间只展示一个切换按钮：当前是看板则显示「列表」，反之显示「看板」。 */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-ui-body"
          onClick={() => {
            const next: ViewMode = viewMode === 'board' ? 'list' : 'board';
            setViewMode(next);
            saveViewMode(next);
          }}
        >
          {viewMode === 'board' ? (
            <List className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Columns3 className="h-3.5 w-3.5" aria-hidden />
          )}
          {viewMode === 'board' ? '列表' : '看板'}
        </Button>
        {viewMode === 'list' && (
          <Select
            value={filters.listColumn ?? 'all'}
            onValueChange={(value) => setFilters((current) => ({
              ...current,
              listColumn: value === 'all' ? null : value as WorkTaskColumnId,
            }))}
          >
            <SelectTrigger className="h-8 w-[7.5rem] px-2 text-ui-caption">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="todo">待办</SelectItem>
              <SelectItem value="inProgress">进行中</SelectItem>
              <SelectItem value="attention">等你处理</SelectItem>
              <SelectItem value="done">完成</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 px-3 text-ui-body"
          onClick={() => {
            setEditingTask(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden />
          新建任务
        </Button>
      </div>

      {viewMode === 'board' ? (
        <div className="flex-1 overflow-x-auto px-4 pb-4">
          <div className="grid h-full min-h-0 grid-cols-4 gap-4">
            {BOARD_COLUMN_IDS.map(renderColumn)}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <TaskListView
            tasks={tasks}
            column={filters.listColumn}
            showCanceled={filters.showCanceled}
            showArchived={filters.showArchived}
            projectNameById={projectNameById}
            onOpen={setDetailTask}
            onEdit={openEditorFor}
            onOpenSession={openSessionFor}
          />
        </div>
      )}

      {isLoading && tasks.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        </div>
      )}

      <TaskDetailDialog
        task={detailTask}
        projectName={detailTask ? projectNameById(detailTask.projectId) : null}
        open={detailTask != null}
        onOpenChange={(open) => {
          if (!open) setDetailTask(null);
        }}
        onEdit={openEditorFor}
        onOpenSession={openSessionFor}
      />

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        task={editingTask}
        defaultProjectId={filters.projectId}
      />
    </div>
  );
}
