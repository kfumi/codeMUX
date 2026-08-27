import { CircleStop, Loader2, MoreHorizontal, Pencil, Play, PlayCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { getScheduledTaskRunMessage } from '../../lib/scheduledTaskRunMessage';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import type { ScheduledTask } from '../../types/scheduledTask';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface AutomationTaskActionsMenuProps {
  task: ScheduledTask;
  onEdit: () => void;
  onDelete: () => void;
}

export function AutomationTaskActionsMenu({
  task,
  onEdit,
  onDelete,
}: AutomationTaskActionsMenuProps) {
  const setEnabled = useScheduledTaskStore((state) => state.setEnabled);
  const runTaskNow = useScheduledTaskStore((state) => state.runTaskNow);
  const [isRunningNow, setIsRunningNow] = useState(false);

  const handleRunNow = async () => {
    setIsRunningNow(true);
    try {
      const run = await runTaskNow(task.id);
      const message = getScheduledTaskRunMessage(run);
      if (message) {
        toast.warning(message);
      } else {
        toast.success('已开始运行');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunningNow(false);
    }
  };

  const handlePause = async () => {
    try {
      await setEnabled(task.id, false);
      toast.success('已暂停');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleContinue = async () => {
    try {
      await setEnabled(task.id, true);
      toast.success('已继续');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          aria-label={`${task.title} 操作`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem
          icon={isRunningNow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          disabled={isRunningNow}
          onClick={() => void handleRunNow()}
        >
          立即运行
        </DropdownMenuItem>
        {task.enabled ? (
          <DropdownMenuItem icon={<CircleStop className="h-3.5 w-3.5" />} onClick={() => void handlePause()}>
            暂停
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon={<PlayCircle className="h-3.5 w-3.5" />} onClick={() => void handleContinue()}>
            继续
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>
          编辑定时任务
        </DropdownMenuItem>
        <div className="my-1 h-px bg-border/60" />
        <DropdownMenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onSelect={() => window.setTimeout(onDelete, 0)}>
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
