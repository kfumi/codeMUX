import { ListTodo, MessageSquare, Settings, Timer, type LucideIcon } from 'lucide-react';

import { useShortcutHint } from '../../hooks/useShortcutHint';
import { useNavigationStore } from '../../stores/navigationStore';
import { selectAttentionCount, useWorkTaskStore } from '../../stores/workTaskStore';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';

/**
 * 导航栏 —— 承载三个顶层视图 + 置底的设置。
 *
 * 对齐 Codex：顶层导航从「侧栏里的文字按钮」提到「窗口最左侧的窄图标栏」，
 * 侧栏随之降级为「随导航栏当前项切换的上下文侧栏」。
 *
 * 宽度按 Codex 实测约 56px 取整（`NAV_RAIL_WIDTH`），图标 18px、按钮 40×40、
 * 圆角走阶梯的 md 档。
 */

export const NAV_RAIL_WIDTH = 56;

export type NavRailTarget = 'app' | 'automation' | 'todo' | 'settings';

interface NavRailProps {
  activeTarget: NavRailTarget;
  onSelect: (target: NavRailTarget) => void;
}

interface RailItem {
  target: NavRailTarget;
  label: string;
  Icon: LucideIcon;
}

const MAIN_ITEMS: RailItem[] = [
  { target: 'app', label: '会话', Icon: MessageSquare },
  { target: 'automation', label: '自动化', Icon: Timer },
  { target: 'todo', label: '工单', Icon: ListTodo },
];

const SETTINGS_ITEM: RailItem = { target: 'settings', label: '设置', Icon: Settings };

export function NavRail({ activeTarget, onSelect }: NavRailProps) {
  const attentionCount = useWorkTaskStore((state) => selectAttentionCount(state.tasks));
  const settingsHint = useShortcutHint('openSettings');

  const hintFor = (item: RailItem) => (item.target === 'settings' ? settingsHint : undefined);

  const renderItem = (item: RailItem) => {
    const active = activeTarget === item.target;
    const hint = hintFor(item);
    const showBadge = item.target === 'todo' && attentionCount > 0;
    return (
      <TooltipHint key={item.target} content={`${item.label}${hint ? ` · ${hint}` : ''}`}>
        <button
          type="button"
          onClick={() => onSelect(item.target)}
          aria-label={item.label}
          aria-current={active ? 'page' : undefined}
          aria-keyshortcuts={hint ?? undefined}
          className={cn(
            'relative flex h-10 w-10 items-center justify-center rounded-md transition-colors duration-fast',
            // 焦点环用不透明主色 + 外偏移：`ring-ring/45` 压在近白表面上只有
            // 约 2:1，达不到 WCAG 2.2 SC 2.4.11 对焦点指示的 3:1。
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-bg))]',
            active
              ? 'bg-[hsl(var(--sidebar-muted))] text-[hsl(var(--foreground))]'
              : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-muted))] hover:text-[hsl(var(--foreground))]',
          )}
        >
          <item.Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          {showBadge && (
            <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-ui-micro font-medium leading-none text-destructive-foreground">
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          )}
        </button>
      </TooltipHint>
    );
  };

  return (
    <nav
      aria-label="主导航"
      data-nav-rail
      style={{ width: NAV_RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center gap-1 bg-[hsl(var(--sidebar-bg))] py-2.5"
    >
      {MAIN_ITEMS.map(renderItem)}
      <div className="flex-1" />
      {renderItem(SETTINGS_ITEM)}
    </nav>
  );
}

/** 从导航 store 的当前视图推出导航栏高亮项。 */
export function navTargetForView(view: 'app' | 'settings' | 'automation' | 'todo'): NavRailTarget {
  return view;
}

/** 便捷 hook：订阅导航 store 并返回当前高亮项。 */
export function useNavRailTarget(): NavRailTarget {
  return useNavigationStore((state) => navTargetForView(state.current.view));
}