import { CircleDot } from 'lucide-react';

import { cn } from '../../lib/utils';

interface AutomationTaskStatusBadgeProps {
  enabled: boolean;
  className?: string;
}

export function AutomationTaskStatusBadge({ enabled, className }: AutomationTaskStatusBadgeProps) {
  if (enabled) {
    return (
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-ui-body text-foreground/88',
          className,
        )}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        运行中
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-ui-body text-muted-foreground',
        className,
      )}
    >
      <CircleDot className="h-3.5 w-3.5 shrink-0 opacity-80" />
      已暂停
    </span>
  );
}
