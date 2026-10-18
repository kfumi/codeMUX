import { ListTodo, MessageSquare, Settings, Timer, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useShortcutHint } from '../../hooks/useShortcutHint';
import { useNavigationStore } from '../../stores/navigationStore';
import { selectAttentionCount, useWorkTaskStore } from '../../stores/workTaskStore';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';
import { CompanionRailButton } from '../companion/CompanionRailButton';
import { ProxyRailStatus } from './ProxyRailStatus';

/**
 * 导航栏 —— 承载三个顶层视图 + 置底的状态与设置。
 *
 * 对齐 Codex：顶层导航从「侧栏里的文字按钮」提到「窗口最左侧的窄图标栏」，
 * 侧栏随之降级为「随导航栏当前项切换的上下文侧栏」。
 *
 * 底部格子从下往上：**设置**（顶层导航的最后一项）、**移动伴侣**、**Proxy 状态灯**、
 * **更新入口**（`accessory`，压在这组图标最上面）。更新入口排在整组之上而不是中间：
 * 它是按更新状态出现/消失的，插在中间会让下面几格移位闪一下。后几者原先长在侧栏页脚
 * （见 04 工单的「页脚上移」）或标题栏左上角，与设置同属「全局 / 不随上下文变」的一类，
 * 因此一起收进这条常驻的图标轨 —— 侧栏切到自动化 / 工单时它们也在，不再随侧栏内容消失。
 *
 * 宽度按 Codex 实测约 56px 取整（`NAV_RAIL_WIDTH`），图标 18px、按钮 40×40、
 * 圆角走阶梯的 md 档。tooltip 一律开在**右侧**：这条轨钉在窗口最左边，往上开会盖住相邻的图标。
 */

export const NAV_RAIL_WIDTH = 56;

export type NavRailTarget = 'app' | 'automation' | 'todo' | 'settings';

interface NavRailProps {
  activeTarget: NavRailTarget;
  onSelect: (target: NavRailTarget) => void;
  /** 置底一格的扩展位（更新入口）—— 排在设置之上，照 Codex 的「更新压着齿轮」。 */
  accessory?: ReactNode;
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

export function NavRail({ activeTarget, onSelect, accessory }: NavRailProps) {
  const attentionCount = useWorkTaskStore((state) => selectAttentionCount(state.tasks));
  const settingsHint = useShortcutHint('openSettings');

  const hintFor = (item: RailItem) => (item.target === 'settings' ? settingsHint : undefined);

  const renderItem = (item: RailItem) => {
    const active = activeTarget === item.target;
    const hint = hintFor(item);
    const showBadge = item.target === 'todo' && attentionCount > 0;
    return (
      <TooltipHint key={item.target} side="right" content={`${item.label}${hint ? ` · ${hint}` : ''}`}>
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
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--chrome-bg))]',
            // 选中/悬停档取 `--chrome-bg-hover`：这里压在**窗口面**上，那一档是
            // 窗口面往 ink 方向走一档（浅色更深、深色更亮），与 Codex 的
            // `buttonTertiaryBackgroundHover` 同一套公式。沿用侧栏的 `--sidebar-muted`
            // 压在窗口面上只剩几级差，等于没按。
            active
              ? 'bg-[hsl(var(--chrome-bg-hover))] text-[hsl(var(--foreground))]'
              : 'text-muted-foreground hover:bg-[hsl(var(--chrome-bg-hover))] hover:text-[hsl(var(--foreground))]',
          )}
        >
          <item.Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          {showBadge && (
            <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive-vivid px-0.5 text-ui-micro font-medium leading-none text-destructive-foreground">
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
      // 图标轨不画自己的底色：它就是**窗口面**的左半边，与顶栏条连成一片 L 形。
      className="flex shrink-0 flex-col items-center gap-1 py-2.5"
    >
      {MAIN_ITEMS.map(renderItem)}
      <div className="flex-1" />
      {/* 更新入口压在整组底部图标**之上**：它出现/消失时下面三格原地不动，
          不会在中间挤出一个空位再让邻居跳一下。 */}
      {accessory}
      <ProxyRailStatus />
      <CompanionRailButton />
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