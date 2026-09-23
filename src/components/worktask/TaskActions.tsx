import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  GitMerge,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '../../lib/utils';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Button } from '../ui/button';
import { TooltipHint } from '../ui/tooltip';
import { useWorkTaskStore } from '../../stores/workTaskStore';
import type { WorkTask } from '../../types/workTask';
import { MergeDialog } from './MergeDialog';

/**
 * 动作渲染布局：
 * - card：看板卡片，主动作「图标 + 文字」胶囊按钮，次要动作为图标圆钮（悬浮提示）。
 * - list：列表行，全部图标圆钮，最紧凑。
 * - detail：详情弹窗，全部「图标 + 文字」，空间充足。
 */
type TaskActionsLayout = 'card' | 'list' | 'detail';

interface TaskActionsProps {
  task: WorkTask;
  onEdit?: (task: WorkTask) => void;
  onOpenSession?: (task: WorkTask) => void;
  /** 动作成功后的回调（如关闭详情弹窗）；动作失败时不会触发，保持弹窗打开。 */
  onSettled?: () => void;
  /** 渲染布局，默认 detail。 */
  layout?: TaskActionsLayout;
}

function actionErrorMessage(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}失败：${message}`;
}

/**
 * 动作矩阵（按状态，与 daemon CAS 转移一致）：
 * - todo: 开始 / 编辑 / 删除
 * - queued|preparing|running: 取消
 * - awaiting_input: 查看会话（有 sessionId）/ 取消
 * - review: 完成 / 查看会话（有 sessionId）/ 合并（仅 worktree 任务有 workBranch）
 * - merging: 无动作
 * - failed: 重试 / 重新开始 / 编辑
 * - done|canceled: 归档（或取消归档）/ 删除
 */
export function TaskActions({
  task,
  onEdit,
  onOpenSession,
  onSettled,
  layout = 'detail',
}: TaskActionsProps) {
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // 动作成功才回调 onSettled（关闭详情弹窗），失败时用户留在原处处理错误。
  const runAction = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busyAction) return false;
    setBusyAction(label);
    try {
      await action();
      onSettled?.();
      return true;
    } catch (error) {
      toast.error(actionErrorMessage(error, label));
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const store = useWorkTaskStore.getState();

  const buttons: { key: string; emphasized: boolean; node: ReactNode }[] = [];

  const pushAction = (
    key: string,
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
    options?: { emphasized?: boolean; destructive?: boolean },
  ) => {
    const emphasized = options?.emphasized === true;
    const labeled = layout === 'detail' || (layout === 'card' && emphasized);
    const handleClick = (event: MouseEvent) => {
      event.stopPropagation();
      onClick();
    };

    let button: ReactNode;
    if (labeled) {
      button = (
        <Button
          type="button"
          variant={emphasized ? 'outline' : 'ghost'}
          size={layout === 'card' ? 'sm' : 'default'}
          disabled={busyAction !== null}
          aria-label={label}
          onClick={handleClick}
          className={cn(
            'gap-1.5',
            layout === 'card' && 'h-7 rounded-full px-2.5 text-ui-caption',
            options?.destructive && 'text-destructive hover:text-destructive',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {label}
        </Button>
      );
    } else {
      button = (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busyAction !== null}
          aria-label={label}
          onClick={handleClick}
          className={cn(
            'h-7 w-7 rounded-full',
            options?.destructive && 'text-destructive hover:text-destructive',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </Button>
      );
    }

    buttons.push({
      key,
      emphasized,
      node: <TooltipHint content={labeled ? undefined : label}>{button}</TooltipHint>,
    });
  };

  const run = (label: string, action: () => Promise<unknown>) => () => {
    void runAction(label, action);
  };

  if (task.status === 'todo') {
    pushAction('start', '开始', Play, run('开始', () => store.startTask(task.id)), {
      emphasized: true,
    });
  }
  if (task.status === 'failed') {
    pushAction('retry', '重试', RotateCcw, run('重试', () => store.retryTask(task.id)), {
      emphasized: true,
    });
    pushAction('restart', '重新开始', RotateCw, run('重新开始', () => store.restartTask(task.id)));
  }
  if (task.status === 'canceled') {
    // canceled 可重新开始：恢复任务继续跑（daemon restart 接受 canceled）。
    pushAction('restart', '重新开始', RotateCw, run('重新开始', () => store.restartTask(task.id)), {
      emphasized: true,
    });
  }
  if (task.sessionId && onOpenSession
    && (task.status === 'awaiting_input' || task.status === 'review')) {
    pushAction(
      'session',
      '查看会话',
      MessageSquare,
      () => onOpenSession(task),
      { emphasized: task.status === 'awaiting_input' },
    );
  }
  if (
    task.status === 'awaiting_input'
    || task.status === 'queued'
    || task.status === 'preparing'
    || task.status === 'running'
  ) {
    pushAction('cancel', '取消', X, run('取消', () => store.cancelTask(task.id)), {
      emphasized: task.status !== 'awaiting_input',
    });
  }
  if (task.status === 'review') {
    pushAction('complete', '完成', Check, run('完成', () => store.completeTask(task.id)), {
      emphasized: true,
    });
    if (task.workBranch) {
      // 合并仅对 worktree 任务可用：daemon 只接受 review→merging 且要求存在工作分支。
      pushAction('merge', '合并', GitMerge, () => setMergeDialogOpen(true));
    }
  }
  if (task.status === 'done' || task.status === 'canceled') {
    pushAction(
      'archive',
      task.archivedAt ? '取消归档' : '归档',
      task.archivedAt ? ArchiveRestore : Archive,
      run(
        task.archivedAt ? '取消归档' : '归档',
        task.archivedAt
          ? () => store.unarchiveTask(task.id)
          : () => store.archiveTask(task.id),
      ),
      { emphasized: true },
    );
  }

  const canEdit = (task.status === 'todo' || task.status === 'failed') && !task.archivedAt && onEdit;
  if (canEdit) {
    pushAction('edit', '编辑', Pencil, () => onEdit?.(task));
  }

  // 待办可直接删除（尚未开始，daemon 删除守卫已放宽到 todo）；终态任务仍可删除。
  const canDelete = task.status === 'todo' || task.status === 'done' || task.status === 'canceled';
  if (canDelete) {
    pushAction('delete', '删除', Trash2, () => setConfirmDeleteOpen(true), {
      destructive: true,
    });
  }

  if (buttons.length === 0) return null;

  const primaryButtons = buttons.filter((entry) => entry.emphasized);
  const secondaryButtons = buttons.filter((entry) => !entry.emphasized);
  const renderNodes = (entries: typeof buttons) =>
    entries.map((entry) => <span key={entry.key}>{entry.node}</span>);

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {layout === 'card' ? (
        // 卡片：主动作靠左，次要动作（编辑/删除等）靠右，分居两侧。
        <div className="flex w-full items-center justify-between gap-1">
          <div className="flex items-center gap-1">{renderNodes(primaryButtons)}</div>
          <div className="flex items-center gap-1">{renderNodes(secondaryButtons)}</div>
        </div>
      ) : (
        renderNodes(buttons)
      )}
      <MergeDialog
        task={task}
        open={mergeDialogOpen}
        onOpenChange={setMergeDialogOpen}
        onMerged={onSettled}
      />
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="删除任务"
        description={`确定删除「${task.title}」吗？删除后不可恢复。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={async () => {
          try {
            await store.deleteTask(task.id);
            toast.success('任务已删除');
            onSettled?.();
          } catch (error) {
            toast.error(actionErrorMessage(error, '删除'));
            throw error;
          }
        }}
      />
    </div>
  );
}
