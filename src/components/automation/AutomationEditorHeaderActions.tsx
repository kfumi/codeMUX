import { CircleStop, Loader2, MoreHorizontal, Play, PlayCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { getScheduledTaskRunMessage } from '../../lib/scheduledTaskRunMessage';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface AutomationEditorHeaderActionsProps {
  taskId: string | null;
  enabled: boolean;
  isSaving: boolean;
  onSave: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onDeleteRequest: () => void;
}

export function AutomationEditorHeaderActions({
  taskId,
  enabled,
  isSaving,
  onSave,
  onEnabledChange,
  onDeleteRequest,
}: AutomationEditorHeaderActionsProps) {
  const runTaskNow = useScheduledTaskStore((state) => state.runTaskNow);
  const setEnabled = useScheduledTaskStore((state) => state.setEnabled);
  const [isRunningNow, setIsRunningNow] = useState(false);

  const handleRunNow = async () => {
    if (!taskId) return;
    setIsRunningNow(true);
    try {
      const run = await runTaskNow(taskId);
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
    if (!taskId) return;
    try {
      await setEnabled(taskId, false);
      onEnabledChange(false);
      toast.success('已暂停');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleContinue = async () => {
    if (!taskId) return;
    try {
      await setEnabled(taskId, true);
      onEnabledChange(true);
      toast.success('已继续');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" onClick={onSave} disabled={isSaving}>
        {isSaving ? '保存中…' : '保存'}
      </Button>
      {taskId && (
        <>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isRunningNow}
            onClick={() => void handleRunNow()}
          >
            {isRunningNow
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Play className="h-3.5 w-3.5" />}
            立即运行
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="更多操作"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              {enabled ? (
                <DropdownMenuItem icon={<CircleStop className="h-3.5 w-3.5" />} onClick={() => void handlePause()}>
                  暂停
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem icon={<PlayCircle className="h-3.5 w-3.5" />} onClick={() => void handleContinue()}>
                  继续
                </DropdownMenuItem>
              )}
              <div className="my-1 h-px bg-border/60" />
              <DropdownMenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onSelect={() => window.setTimeout(onDeleteRequest, 0)}>
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
