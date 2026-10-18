import { ListTodo, MessageSquare, Timer, type LucideIcon } from 'lucide-react';

import { selectAttentionCount, useWorkTaskStore } from '../../stores/workTaskStore';
import { cn } from '../../lib/utils';
import type { NavRailTarget } from './NavRail';

/**
 * 窄屏抽屉顶部的视图切换器 —— 桌面端那条 56px 图标轨（NavRail）在窄屏下的等价物。
 *
 * 图标轨是桌面解法：它常驻在窗口最左边，靠 hover tooltip 说明图标含义。窄屏上继续
 * 占着这 56px，390px 的手机就只剩 334px 给内容。于是整条轨在窄屏隐藏，改成抽屉里
 * 这一行带文字的分段按钮 —— 顶层视图入口一个不少（会话 / 自动化 / 工单）。
 *
 * 与图标轨保持一致的行为：当前项有明确选中态，工单项在有待办时带徽标。
 * 设置不在这行里：它和 Proxy 状态、移动伴侣一起钉在抽屉页脚
 * （见 `NarrowNavFooter`），与图标轨「设置置底」同一套层级。
 */

interface NarrowNavSwitcherProps {
  activeTarget: NavRailTarget;
  onSelect: (target: NavRailTarget) => void;
}

interface SwitcherItem {
  target: NavRailTarget;
  label: string;
  Icon: LucideIcon;
}

const VIEW_ITEMS: SwitcherItem[] = [
  { target: 'app', label: '会话', Icon: MessageSquare },
  { target: 'automation', label: '自动化', Icon: Timer },
  { target: 'todo', label: '工单', Icon: ListTodo },
];

export function NarrowNavSwitcher({ activeTarget, onSelect }: NarrowNavSwitcherProps) {
  const attentionCount = useWorkTaskStore((state) => selectAttentionCount(state.tasks));

  return (
    <nav
      aria-label="视图切换"
      data-narrow-nav-switcher
      className="flex shrink-0 items-center gap-1 border-b border-[hsl(var(--layout-divider))] px-3 pb-2.5 pt-3"
    >
      {VIEW_ITEMS.map(({ target, label, Icon }) => {
        const active = activeTarget === target;
        const showBadge = target === 'todo' && attentionCount > 0;
        return (
          <button
            key={target}
            type="button"
            onClick={() => onSelect(target)}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-ui-meta transition-colors duration-fast',
              // 这一行压在**侧栏面**上，选中/悬停档因此取侧栏那一档（`--sidebar-muted`），
              // 与侧栏其余行一致；图标轨那一档（`--chrome-bg-hover`）是窗口面的悬停色，
              // 压在侧栏上只差几级，等于没按。
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-bg))]',
              active
                ? 'bg-[hsl(var(--sidebar-muted))] text-foreground'
                : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-muted))]/60 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{label}</span>
            {showBadge && (
              <span className="flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full bg-destructive-vivid px-0.5 text-ui-micro font-medium leading-none text-destructive-foreground">
                {attentionCount > 99 ? '99+' : attentionCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
