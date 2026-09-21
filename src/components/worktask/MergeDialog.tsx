import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { useWorkTaskStore } from '../../stores/workTaskStore';
import type { WorkTask } from '../../types/workTask';

interface MergeDialogProps {
  task: WorkTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 合并成功后的回调（如关闭详情弹窗）。 */
  onMerged?: () => void;
}

/**
 * 合并确认弹窗（story 18）：可自定义合并提交信息，留空则由 daemon 自动生成。
 * 提交失败时弹窗保持打开，用户可直接重试。
 */
export function MergeDialog({ task, open, onOpenChange, onMerged }: MergeDialogProps) {
  const mergeTask = useWorkTaskStore((state) => state.mergeTask);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  // 每次打开重置输入，避免残留上一次的自定义信息。
  useEffect(() => {
    if (open) setMessage('');
  }, [open, task.id]);

  const confirmMerge = async () => {
    if (pending) return;
    setPending(true);
    try {
      await mergeTask(task.id, message.trim() || undefined);
      toast.success('已开始合并');
      onOpenChange(false);
      onMerged?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast.error(`合并失败：${detail}`);
      // 失败时保持弹窗打开，用户可修改信息后重试。
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>合并任务</DialogTitle>
          <DialogDescription>
            将「{task.title}」的工作分支
            {task.workBranch && <span className="font-mono text-code"> {task.workBranch} </span>}
            合并回{task.baseBranch ? (
              <span className="font-mono text-code"> {task.baseBranch}</span>
            ) : '基线分支'}
            。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="merge-message"
            className="text-ui-caption text-muted-foreground"
          >
            合并提交信息（留空自动生成）
          </label>
          <Input
            id="merge-message"
            value={message}
            placeholder="例如：fix: 修复登录页校验"
            onChange={(event) => setMessage(event.target.value)}
            disabled={pending}
          />
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-3.5 text-ui-compact"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 px-3.5 text-ui-compact"
            onClick={() => void confirmMerge()}
            disabled={pending}
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            合并
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
