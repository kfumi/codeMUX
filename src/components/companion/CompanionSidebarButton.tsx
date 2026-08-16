import { useState } from 'react';
import { Smartphone } from 'lucide-react';

import { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { getCompanionVisualState, companionVisualStateLabel } from '../../lib/companion';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { CompanionDialog } from './CompanionDialog';

function iconClassForState(visualState: ReturnType<typeof getCompanionVisualState>): string {
  if (visualState === 'paired') {
    return 'text-[hsl(var(--success))]';
  }
  if (visualState === 'waiting' || visualState === 'reconnecting') {
    return 'text-[hsl(var(--warning))]';
  }
  return 'text-[hsl(var(--sidebar-fg))]/66';
}

function tooltipForState(visualState: ReturnType<typeof getCompanionVisualState>): string {
  if (visualState === 'idle') return '移动伴侣';
  return `移动伴侣：${companionVisualStateLabel(visualState)}`;
}

export function CompanionSidebarButton() {
  const [open, setOpen] = useState(false);
  const controller = useCompanionStatus({ pollIntervalMs: 12_000, polling: true });
  const visualState = getCompanionVisualState(controller.status);

  const handleOpen = () => {
    setOpen(true);
    if (!controller.status?.enabled && !controller.busy && !controller.loading) {
      void controller.setEnabled(true);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleOpen}
            aria-label="移动伴侣"
            className={cn(
              'flex shrink-0 items-center rounded-md p-2 transition-colors duration-150 hover:bg-[hsl(var(--sidebar-muted))]/78',
              iconClassForState(visualState),
            )}
          >
            <Smartphone className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{tooltipForState(visualState)}</p>
        </TooltipContent>
      </Tooltip>

      <CompanionDialog open={open} onOpenChange={setOpen} controller={controller} />
    </>
  );
}
