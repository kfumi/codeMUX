import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import type { WorkTask, WorkTaskEvent } from '../../types/workTask';
import { StatusChip } from './StatusChip';
import { TaskActions } from './TaskActions';
import { formatRelativeTime } from './relativeTime';

interface TaskDetailDialogProps {
  task: WorkTask | null;
  projectName?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (task: WorkTask) => void;
  onOpenSession: (task: WorkTask) => void;
}

/** 事件 kind → 中文标签；未收录的 kind 原样展示。 */
const EVENT_KIND_LABELS: Record<string, string> = {
  created: '创建',
  start: '启动',
  started: '启动',
  cancel: '取消',
  canceled: '取消',
  retry: '重试',
  restart: '重新开始',
  merge: '合并',
  merged: '合并',
  complete: '完成',
  completed: '完成',
  status_changed: '状态流转',
  updated: '更新',
  archived: '归档',
  unarchived: '取消归档',
};

function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}

function completionKindLabel(completionKind: string | null): string | null {
  if (completionKind === 'merged') return '已合并';
  if (completionKind === 'completed_without_merge') return '未合并完成';
  return completionKind;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-ui-body">
      <span className="w-20 shrink-0 text-ui-caption text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-foreground">{children}</span>
    </div>
  );
}

/** 本期详情用 Dialog 承载（只读信息 + 动作按钮区 + 时间线），侧滑留待后续工单。 */
export function TaskDetailDialog({
  task,
  projectName,
  open,
  onOpenChange,
  onEdit,
  onOpenSession,
}: TaskDetailDialogProps) {
  const [events, setEvents] = useState<WorkTaskEvent[] | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);

  useEffect(() => {
    if (!open || !task) {
      setEvents(null);
      setEventsFailed(false);
      return;
    }
    let cancelled = false;
    setEvents(null);
    setEventsFailed(false);
    daemonFacade.workTasks
      .listEvents(task.id)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {
        // 拉取失败静默：展示「暂无时间线」。
        if (!cancelled) setEventsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, task]);

  const timeline = events === null
    ? []
    : [...events].sort((left, right) => right.id - left.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="break-all pr-8">{task.title}</DialogTitle>
              <DialogDescription className="flex items-center gap-2">
                <StatusChip status={task.status} />
                {projectName && <span>{projectName}</span>}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              {task.instruction && (
                <InfoRow label="指令">
                  <span className="whitespace-pre-wrap">{task.instruction}</span>
                </InfoRow>
              )}
              {task.lastError && (
                <InfoRow label="错误">
                  <span className="whitespace-pre-wrap text-destructive">{task.lastError}</span>
                </InfoRow>
              )}
              {task.resultSummary && (
                <InfoRow label="结果">
                  <span className="whitespace-pre-wrap">{task.resultSummary}</span>
                </InfoRow>
              )}
              <InfoRow label="Agent">{task.agentKind}</InfoRow>
              {task.model && <InfoRow label="模型">{task.model}</InfoRow>}
              {task.sessionId && (
                <InfoRow label="会话">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-code break-all">{task.sessionId}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-ui-caption"
                      onClick={() => onOpenSession(task)}
                    >
                      查看会话
                    </Button>
                  </span>
                </InfoRow>
              )}
              {task.workBranch && (
                <InfoRow label="工作分支">
                  <span className="font-mono text-code">{task.workBranch}</span>
                </InfoRow>
              )}
              {task.baseBranch && (
                <InfoRow label="基线分支">
                  <span className="font-mono text-code">{task.baseBranch}</span>
                </InfoRow>
              )}
              {task.status === 'done' && completionKindLabel(task.completionKind) && (
                <InfoRow label="完成方式">{completionKindLabel(task.completionKind)}</InfoRow>
              )}
              {task.worktreePath && <InfoRow label="工作树">{task.worktreePath}</InfoRow>}
              {task.status === 'canceled' && task.worktreePath && (
                <InfoRow label="提示">
                  <span className="text-warning">
                    已保留工作分支，可重新开始任务或手动清理该工作树。
                  </span>
                </InfoRow>
              )}
              {(task.filesChanged !== null || task.additions !== null || task.deletions !== null) && (
                <InfoRow label="变更统计">
                  <span className="font-mono text-code">
                    {task.filesChanged !== null && task.filesChanged > 0 && (
                      <span>{task.filesChanged} 个文件</span>
                    )}
                    {task.additions !== null && task.additions > 0 && (
                      <span className="text-success">+{task.additions}</span>
                    )}
                    {task.deletions !== null && task.deletions > 0 && (
                      <span className="text-destructive">-{task.deletions}</span>
                    )}
                  </span>
                </InfoRow>
              )}
              <InfoRow label="创建时间">{formatRelativeTime(task.createdAt)}</InfoRow>
              <InfoRow label="更新时间">{formatRelativeTime(task.updatedAt)}</InfoRow>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-ui-body font-medium text-foreground">时间线</span>
              {eventsFailed || (events !== null && timeline.length === 0) ? (
                <p className="text-ui-caption text-muted-foreground">暂无时间线</p>
              ) : events === null ? (
                <p className="text-ui-caption text-muted-foreground">加载中……</p>
              ) : (
                <ul className="space-y-1">
                  {timeline.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-ui-caption"
                    >
                      <span className="font-medium text-foreground">
                        {eventKindLabel(event.kind)}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatRelativeTime(event.createdAt)}
                      </span>
                      {event.detail && (
                        <span className="min-w-0 flex-1 break-all text-muted-foreground">
                          {event.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-end">
              <TaskActions
                task={task}
                onEdit={onEdit}
                onOpenSession={onOpenSession}
                onSettled={() => onOpenChange(false)}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
