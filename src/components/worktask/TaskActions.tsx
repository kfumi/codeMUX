import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '../ui/confirm-dialog';
import { Button } from '../ui/button';
import { useWorkTaskStore } from '../../stores/workTaskStore';
import type { WorkTask } from '../../types/workTask';
import { MergeDialog } from './MergeDialog';

interface TaskActionsProps {
  task: WorkTask;
  onEdit?: (task: WorkTask) => void;
  onOpenSession?: (task: WorkTask) => void;
  /** 动作成功后的回调（如关闭详情弹窗）；动作失败时不会触发，保持弹窗打开。 */
  onSettled?: () => void;
  /** 紧凑模式（卡片底部）。 */
  compact?: boolean;
}

function actionErrorMessage(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}失败：${message}`;
}

/**
 * 动作矩阵（按状态，与 daemon CAS 转移一致）：
 * - todo: 开始 / 编辑
 * - queued|preparing|running: 取消
 * - awaiting_input: 查看会话（有 sessionId）/ 取消
 * - review: 查看会话（有 sessionId）/ 完成 / 合并（仅 worktree 任务有 workBranch）
 * - merging: 无动作
 * - failed: 重试 / 重新开始 / 编辑
 * - done: 归档（或取消归档）/ 删除
 * - canceled: 重新开始 / 归档（或取消归档）/ 删除
 */
export function TaskActions({ task, onEdit, onOpenSession, onSettled, compact = true }: TaskActionsProps) {
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const sizeClass = compact ? 'h-7 px-2 text-ui-caption' : undefined;

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

  const buttons: ReactNode[] = [];
  const push = (key: string, node: ReactNode) => buttons.push(<span key={key}>{node}</span>);

  const ghostButton = (
    label: string,
    action: () => Promise<unknown>,
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={sizeClass}
      disabled={busyAction !== null}
      onClick={(event) => {
        event.stopPropagation();
        void runAction(label, action);
      }}
    >
      {label}
    </Button>
  );

  if (task.status === 'todo') {
    push('start', ghostButton('开始', () => store.startTask(task.id)));
  }
  if (task.status === 'failed') {
    push('retry', ghostButton('重试', () => store.retryTask(task.id)));
    push('restart', ghostButton('重新开始', () => store.restartTask(task.id)));
  }
  if (task.status === 'canceled') {
    // canceled 可重新开始：恢复 story 23 的任务继续跑（daemon restart 接受 canceled）。
    push('restart', ghostButton('重新开始', () => store.restartTask(task.id)));
  }
  if (
    task.status === 'awaiting_input'
    || task.status === 'queued'
    || task.status === 'preparing'
    || task.status === 'running'
  ) {
    push('cancel', ghostButton('取消', () => store.cancelTask(task.id)));
  }
  if (task.sessionId && onOpenSession
    && (task.status === 'awaiting_input' || task.status === 'review')) {
    push('session', (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={sizeClass}
        onClick={(event) => {
          event.stopPropagation();
          onOpenSession(task);
        }}
      >
        查看会话
      </Button>
    ));
  }
  if (task.status === 'review') {
    push('complete', ghostButton('完成', () => store.completeTask(task.id)));
    if (task.workBranch) {
      // 合并仅对 worktree 任务可用：daemon 只接受 review→merging 且要求存在工作分支。
      push('merge', (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={sizeClass}
          disabled={busyAction !== null}
          onClick={(event) => {
            event.stopPropagation();
            setMergeDialogOpen(true);
          }}
        >
          合并
        </Button>
      ));
    }
  }
  if (task.status === 'done' || task.status === 'canceled') {
    push('archive', task.archivedAt ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={sizeClass}
        disabled={busyAction !== null}
        onClick={(event) => {
          event.stopPropagation();
          void runAction('取消归档', () => store.unarchiveTask(task.id));
        }}
      >
        取消归档
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={sizeClass}
        disabled={busyAction !== null}
        onClick={(event) => {
          event.stopPropagation();
          void runAction('归档', () => store.archiveTask(task.id));
        }}
      >
        归档
      </Button>
    ));
  }

  const canEdit = (task.status === 'todo' || task.status === 'failed') && !task.archivedAt && onEdit;
  if (canEdit) {
    push('edit', (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={sizeClass}
        onClick={(event) => {
          event.stopPropagation();
          onEdit?.(task);
        }}
      >
        编辑
      </Button>
    ));
  }

  // 删除仅终态（done/canceled）可用：daemon 拒绝删除其他状态。
  if (task.status === 'done' || task.status === 'canceled') {
    push('delete', (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${sizeClass ?? ''} text-destructive hover:text-destructive`}
        disabled={busyAction !== null}
        onClick={(event) => {
          event.stopPropagation();
          setConfirmDeleteOpen(true);
        }}
      >
        删除
      </Button>
    ));
  }

  if (buttons.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {buttons}
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
