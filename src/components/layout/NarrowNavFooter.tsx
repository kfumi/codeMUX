import { useState, type ReactNode } from 'react';
import { Radio, Settings, Smartphone } from 'lucide-react';

import { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { getCompanionVisualState, companionVisualStateLabel, type CompanionVisualState } from '../../lib/companion';
import { useSettingsStore } from '../../stores/settingsStore';
import { cn } from '../../lib/utils';
import type { NavRailTarget } from './NavRail';
import { CompanionDialog } from '../companion/CompanionDialog';

/**
 * 窄屏抽屉页脚 —— 桌面端图标轨底部几格（Proxy 状态灯 / 移动伴侣 / 更新入口 / 设置）
 * 在窄屏下的等价物。
 *
 * 图标轨在窄屏整条隐藏，底部这三格跟着搬进抽屉页脚，顺序与图标轨一致
 * （设置钉在最下面）。它们与分段切换器（`NarrowNavSwitcher`）同属「全局、不随
 * 侧栏上下文变」的一类，因此由布局层渲染，而不是塞进 `Sidebar` —— 侧栏内容随
 * 顶层视图切换时（会话树 / 设置分页 / 自动化列表），这一页脚始终都在。
 *
 * 窄屏抽屉没有 hover，这三行因此直接带文字：Proxy 状态还拿回了当初为了塞进 56px
 * 轨道而丢掉的端口号（「Proxy 运行中 · :4312」）。它们压在**侧栏面**上，悬停档
 * 取侧栏那一档（`--sidebar-muted`），与侧栏其余行一致；图标轨那一档
 * （`--chrome-bg-hover`）是窗口面的悬停色，用在这里只差几级，等于没按。
 */

interface NarrowNavFooterProps {
  activeTarget: NavRailTarget;
  onSelect: (target: NavRailTarget) => void;
  /** 图标轨置底扩展位（更新入口）在窄屏页脚里的等价行。 */
  accessory?: ReactNode;
}

function companionIconColor(visualState: CompanionVisualState): string {
  if (visualState === 'paired') {
    return 'text-[hsl(var(--success))]';
  }
  if (visualState === 'waiting' || visualState === 'reconnecting') {
    return 'text-[hsl(var(--warning))]';
  }
  return 'text-muted-foreground';
}

function CompanionRow() {
  // 非桌面宿主没有移动伴侣管理面(daemon 只接受回环来源),整行不渲染。
  const canManageCompanion = useHostCapabilities().has('companion.manage');
  const [open, setOpen] = useState(false);
  const controller = useCompanionStatus({ pollIntervalMs: 12_000, polling: canManageCompanion });
  const visualState = getCompanionVisualState(controller.status);

  if (!canManageCompanion) {
    return null;
  }

  const handleOpen = () => {
    setOpen(true);
    if (!controller.status?.enabled && !controller.busy && !controller.loading) {
      void controller.setEnabled(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="移动伴侣"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-ui-meta text-foreground transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-bg))]"
      >
        <Smartphone className={cn('h-4 w-4 shrink-0', companionIconColor(visualState))} strokeWidth={1.75} />
        <span className="flex-1 text-left">移动伴侣</span>
        {visualState !== 'idle' && (
          <span className="shrink-0 text-ui-caption text-muted-foreground">
            {companionVisualStateLabel(visualState)}
          </span>
        )}
      </button>
      <CompanionDialog open={open} onOpenChange={setOpen} controller={controller} />
    </>
  );
}

function ProxyRow() {
  const proxyRunning = useSettingsStore((state) => state.proxyRunning);
  const proxyUrl = useSettingsStore((state) => state.proxyUrl);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const label = proxyRunning ? `Proxy 运行中${port ? ` · :${port}` : ''}` : 'Proxy 未运行';

  return (
    <span
      role="status"
      aria-label={label}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-ui-meta"
    >
      <Radio
        className={cn('h-4 w-4 shrink-0', proxyRunning ? 'text-[hsl(var(--success))]' : 'text-muted-foreground')}
        strokeWidth={1.75}
      />
      <span className="flex-1 text-left text-foreground">{label}</span>
    </span>
  );
}

export function NarrowNavFooter({ activeTarget, onSelect, accessory }: NarrowNavFooterProps) {
  const settingsActive = activeTarget === 'settings';

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-[hsl(var(--layout-divider))] px-3 py-2">
      {/* 更新入口压在这组之上，出现/消失不让邻居移位（与图标轨同一顺序）。 */}
      {accessory}
      <ProxyRow />
      <CompanionRow />
      <button
        type="button"
        onClick={() => onSelect('settings')}
        aria-label="设置"
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-ui-meta transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-bg))]',
          settingsActive
            ? 'bg-[hsl(var(--sidebar-muted))] text-foreground'
            : 'text-foreground hover:bg-[hsl(var(--sidebar-muted))]/82',
        )}
      >
        <Settings className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span className="flex-1 text-left">设置</span>
      </button>
    </div>
  );
}
