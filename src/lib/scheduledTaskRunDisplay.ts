import type { TaskRun, TaskRunStatus } from '../types/scheduledTask';

export function formatRunTriggerTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function formatRunDuration(run: TaskRun): string {
  if (!run.startedAt) return '—';
  if (!run.finishedAt) {
    if (run.status === 'running' || run.status === 'awaiting_input') {
      return '…';
    }
    return '—';
  }
  const durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (durationMs < 0) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function getRunStatusPresentation(status: TaskRunStatus): {
  label: string;
  dotClassName: string;
  textClassName: string;
} {
  switch (status) {
    case 'completed':
      return {
        label: '成功',
        dotClassName: 'bg-emerald-500',
        textClassName: 'text-foreground/88',
      };
    case 'failed':
      return {
        label: '失败',
        dotClassName: 'bg-destructive',
        textClassName: 'text-destructive',
      };
    case 'running':
      return {
        label: '运行中',
        dotClassName: 'bg-sky-500',
        textClassName: 'text-foreground/88',
      };
    case 'awaiting_input':
      return {
        label: '等待输入',
        dotClassName: 'bg-amber-500',
        textClassName: 'text-foreground/88',
      };
    case 'skipped':
      return {
        label: '已跳过',
        dotClassName: 'bg-muted-foreground',
        textClassName: 'text-muted-foreground',
      };
    default:
      return {
        label: status,
        dotClassName: 'bg-muted-foreground',
        textClassName: 'text-muted-foreground',
      };
  }
}
