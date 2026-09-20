import { Check, Loader2 } from 'lucide-react';

import type { WorkTaskStatus } from '../../types/workTask';
import { cn } from '../../lib/utils';

export const WORK_TASK_STATUS_LABELS: Record<WorkTaskStatus, string> = {
  todo: '待办',
  queued: '排队中',
  preparing: '准备中',
  running: '运行中',
  awaiting_input: '等待输入',
  review: '待审查',
  merging: '合并中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
};

type ChipTone = 'primary' | 'warning' | 'success' | 'red' | 'gray';

const TONE_CLASSES: Record<ChipTone, string> = {
  // 语义 token（success/warning 来自 globals.css @theme），浅/深主题自动适配。
  primary: 'bg-primary/10 text-primary',
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
  red: 'bg-destructive/10 text-destructive',
  gray: 'bg-muted text-muted-foreground',
};

function toneForStatus(status: WorkTaskStatus): ChipTone {
  switch (status) {
    case 'queued':
    case 'preparing':
    case 'running':
    case 'merging':
      return 'primary';
    case 'awaiting_input':
    case 'review':
    return 'warning';
    case 'done':
    return 'success';
    case 'failed':
      return 'red';
    case 'todo':
    case 'canceled':
      return 'gray';
  }
}

function isSpinning(status: WorkTaskStatus): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running' || status === 'merging';
}

export function StatusChip({ status, className }: { status: WorkTaskStatus; className?: string }) {
  const tone = toneForStatus(status);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-ui-caption font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {isSpinning(status) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {status === 'done' && <Check className="h-3 w-3" aria-hidden />}
      {WORK_TASK_STATUS_LABELS[status]}
    </span>
  );
}
