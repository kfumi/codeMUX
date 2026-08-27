import { ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  formatRunDuration,
  formatRunTriggerTime,
  getRunStatusPresentation,
} from '../../lib/scheduledTaskRunDisplay';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import type { TaskRun } from '../../types/scheduledTask';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface AutomationTaskHistoryPanelProps {
  taskId: string;
  projectId: string | null;
  runs: TaskRun[];
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

function openAfterMenuClose(action: () => void) {
  window.setTimeout(action, 0);
}

export function AutomationTaskHistoryPanel({
  taskId,
  projectId,
  runs,
  onOpenSession,
}: AutomationTaskHistoryPanelProps) {
  const deleteRun = useScheduledTaskStore((state) => state.deleteRun);
  const [deleteTarget, setDeleteTarget] = useState<TaskRun | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteRun(taskId, deleteTarget.id);
      toast.success('已删除记录');
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (runs.length === 0) {
    return (
      <p className="text-ui-body text-muted-foreground">还没有执行记录。</p>
    );
  }

  return (
    <>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除记录"
        description="确定删除这条执行记录吗？关联会话不会被删除。"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
      />
      <div className="overflow-hidden rounded-lg border border-border/70">
        <div
          className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.7fr)_2rem] items-center gap-3 border-b border-border/60 bg-muted/25 px-4 py-2.5 text-ui-body text-muted-foreground"
        >
          <span>触发时间</span>
          <span>状态</span>
          <span>时长</span>
          <span className="sr-only">操作</span>
        </div>
        <div className="divide-y divide-border/50">
          {runs.map((run) => {
            const status = getRunStatusPresentation(run.status);
            return (
              <div
                key={run.id}
                className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.7fr)_2rem] items-center gap-3 px-4 py-3"
              >
                <span className="truncate text-ui-body text-foreground/88">
                  {formatRunTriggerTime(run.scheduledFor)}
                </span>
                <span className={`inline-flex items-center gap-1.5 text-ui-body ${status.textClassName}`}>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClassName}`} />
                  {status.label}
                </span>
                <span className="text-ui-body text-muted-foreground">
                  {formatRunDuration(run)}
                </span>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="记录操作"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-36">
                    <DropdownMenuItem
                      icon={<ExternalLink className="h-3.5 w-3.5" />}
                      disabled={!run.sessionId}
                      onSelect={() => {
                        if (run.sessionId) onOpenSession(run.sessionId, projectId);
                      }}
                    >
                      跳到会话
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      danger
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      onSelect={() => openAfterMenuClose(() => setDeleteTarget(run))}
                    >
                      删除记录
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
