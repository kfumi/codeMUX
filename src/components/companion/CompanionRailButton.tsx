import { useState } from 'react';
import { Smartphone } from 'lucide-react';

import { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { getCompanionVisualState, companionVisualStateLabel } from '../../lib/companion';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';
import { CompanionDialog } from './CompanionDialog';

function iconClassForState(visualState: ReturnType<typeof getCompanionVisualState>): string {
  if (visualState === 'paired') {
    return 'text-[hsl(var(--success))]';
  }
  if (visualState === 'waiting' || visualState === 'reconnecting') {
    return 'text-[hsl(var(--warning))]';
  }
  return 'text-muted-foreground';
}

function tooltipForState(visualState: ReturnType<typeof getCompanionVisualState>): string {
  if (visualState === 'idle') return '移动伴侣';
  return `移动伴侣：${companionVisualStateLabel(visualState)}`;
}

/**
 * 移动伴侣入口 —— 图标轨上的一格，与 Proxy 状态灯、设置排在一起。
 *
 * 从侧栏页脚搬过来时换了那一套平面 token：图标轨压在**窗口面**上，悬停档因此取
 * `--chrome-bg-hover`（不是侧栏的 `--sidebar-muted`），焦点环的外偏移底色也是窗口面。
 * 图标颜色仍然承担状态（绿 = 已配对 / 琥珀 = 等待或重连 / 次级 = 未启用）。
 */
export function CompanionRailButton() {
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
      <TooltipHint side="right" content={tooltipForState(visualState)}>
        <button
          type="button"
          onClick={handleOpen}
          aria-label="移动伴侣"
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors duration-fast',
            'hover:bg-[hsl(var(--chrome-bg-hover))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--chrome-bg))]',
            iconClassForState(visualState),
          )}
        >
          <Smartphone className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </TooltipHint>

      <CompanionDialog open={open} onOpenChange={setOpen} controller={controller} />
    </>
  );
}
