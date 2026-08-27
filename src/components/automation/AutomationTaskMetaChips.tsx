import { CircleDot, Clock } from 'lucide-react';

import {
  formatNextRunRelative,
  formatRunCount,
  formatScheduleSummary,
} from '../../lib/scheduleSummary';
import type { ScheduledTask } from '../../types/scheduledTask';
import { cn } from '../../lib/utils';

interface AutomationTaskMetaChipsProps {
  task: ScheduledTask;
  nowMs: number;
  className?: string;
}

function weeklyWeekdaysForTask(task: ScheduledTask): number[] {
  if (task.weeklyWeekdays && task.weeklyWeekdays.length > 0) {
    return task.weeklyWeekdays;
  }
  if (task.weeklyWeekday != null) {
    return [task.weeklyWeekday];
  }
  return [];
}

export function AutomationTaskMetaChips({ task, nowMs, className }: AutomationTaskMetaChipsProps) {
  const scheduleLabel = formatScheduleSummary(
    task.scheduleKind,
    task.scheduleTime,
    weeklyWeekdaysForTask(task),
    task.monthlyDay ?? 1,
    task.timezone,
    { includeTimezone: false },
  );

  const nextRunLabel = task.enabled ? formatNextRunRelative(task.nextRunAt, nowMs) : '';

  return (
    <div className={cn('mt-2 flex items-center gap-2', className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {!task.enabled && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-ui-body text-muted-foreground"
          >
            <CircleDot className="h-3 w-3 shrink-0 opacity-80" />
            已暂停
          </span>
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-ui-body',
            task.enabled
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
              : 'border-border/50 bg-muted/30 text-muted-foreground',
          )}
        >
          <Clock className="h-3 w-3 shrink-0 opacity-80" />
          <span>
            {scheduleLabel}
            {nextRunLabel ? ` · 下次运行 ${nextRunLabel}` : ''}
          </span>
        </span>
      </div>
      <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-ui-body text-muted-foreground">
        {formatRunCount(task.runCount ?? 0)}
      </span>
    </div>
  );
}
