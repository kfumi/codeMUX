import { type ReactNode, useEffect, useState } from 'react';
import {
  Check,
  Minus,
  Monitor,
  Moon,
  SquareTerminalIcon,
  Sun,
  X,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { desktopBridge } from '../../lib/desktop-bridge';
import { shellFacade } from '../../lib/facades/shell-facade';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { useShortcutAriaKeyshortcuts, useShortcutHint } from '../../hooks/useShortcutHint';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useTerminalDockStore } from '../../stores/terminalDockStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import type { TodoItem } from '../../types/agent';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { ProjectOpenTargetButton } from './ProjectOpenTargetButton';
import { RoundedPanelIcon } from './RoundedPanelIcon';
import { GitEnvironmentPopover } from '../workspace/review/GitEnvironmentPopover';

const EMPTY_TODOS: TodoItem[] = [];

function MaximizeIcon({ restored }: { restored: boolean }) {
  if (restored) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M3 1.5H8.5V7" />
        <path d="M1.5 3H7V8.5H1.5Z" />
      </svg>
    );
  }

  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="1.5" y="1.5" width="7" height="7" />
    </svg>
  );
}

export interface TitleBarNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

interface TitleBarProps {
  leftContent?: ReactNode;
  rightContent?: ReactNode;
  projectOpenPath?: string | null;
  sidePanelAvailable?: boolean;
  todos?: TodoItem[];
  /**
   * 侧栏与内容区并排时，顶栏按两者边界分成两段：左段只放导航控件，
   * 会话标题/项目等从分割线右侧开始。分割线位置由 `.app-shell` 上的
   * `--titlebar-split` 提供，与侧栏宽度同源。
   */
  splitAtSidebar?: boolean;
  /** 侧栏拖拽中禁用分段宽度过渡，保证分割线与侧栏同帧移动。 */
  sidebarResizing?: boolean;
}

export function TitleBar({
  leftContent,
  rightContent,
  projectOpenPath,
  sidePanelAvailable = true,
  todos = EMPTY_TODOS,
  splitAtSidebar = false,
  sidebarResizing = false,
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const currentTheme = useSettingsStore((state) => state.config?.theme || 'System');
  const setTheme = useSettingsStore((state) => state.setTheme);
  const sidePanelOpen = useSidePanelStore((state) => state.isOpen);
  const openSidePanel = useSidePanelStore((state) => state.openPanel);
  const closeSidePanel = useSidePanelStore((state) => state.closePanel);
  // 宿主能力清单(工单 02):窗口控件与自绘标题栏是壳独占,浏览器形态隐藏。
  const { presentation } = useHostCapabilities();
  // tooltip 与 aria-keyshortcuts 都跟着用户的改键走（写法与 MainLayout 一致）。
  const sidePanelHint = useShortcutHint('toggleSidePanel');
  const sidePanelAria = useShortcutAriaKeyshortcuts('toggleSidePanel');
  const terminalDockOpen = useTerminalDockStore((state) => state.isOpen);
  const toggleTerminalDock = useTerminalDockStore((state) => state.toggle);
  const terminalDockHint = useShortcutHint('toggleTerminalDock');
  const terminalDockAria = useShortcutAriaKeyshortcuts('toggleTerminalDock');

  const ThemeIcon = currentTheme === 'Dark' ? Moon : currentTheme === 'Light' ? Sun : Monitor;

  // 自绘标题栏(工单 09):窗口命令走壳桥,最大化态经 main 的
  // window-maximize-changed 桌面事件订阅;桥缺失(纯 Web)时不渲染窗口按钮。
  useEffect(() => {
    if (!presentation.windowControls || !desktopBridge) return;

    let disposed = false;
    desktopBridge.isWindowMaximized()
      .then((value) => {
        if (!disposed) setMaximized(value);
      })
      .catch(() => {});

    const unsubscribe = desktopBridge.onDesktopEvent('window-maximize-changed', (payload) => {
      setMaximized(payload === true);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [presentation.windowControls]);

  const themeOptions: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
    { value: 'Light', label: '浅色', Icon: Sun },
    { value: 'Dark', label: '深色', Icon: Moon },
    { value: 'System', label: '跟随系统', Icon: Monitor },
  ];

  // 没有左侧控件（无侧栏）时没有可对齐的边界，不拆段。
  const split = splitAtSidebar && leftContent != null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-app-drag-region
          // 标题栏是**窗口面**本身，不自己画底色，也不画下边线：它与左侧图标轨共用
          // `.app-shell` 的那块底，连着画才不会在轨道的正上方横切一道线。内容面与
          // 侧栏各自带发丝描边（elevation / border-r），边界不缺。
          className="relative z-20 flex h-12 shrink-0 select-none items-stretch"
        >
          {leftContent && (
            <div
              data-titlebar-left-region
              className={cn(
                'flex h-full items-center pl-2',
                split && 'shrink-0',
                // 过渡与侧栏的 width 过渡同参：展开/收起时一起走完；拖拽时两边
                // 同时关掉过渡，分割线跟手不落后。
                split && (sidebarResizing
                  ? 'transition-none'
                  : 'transition-[width] duration-slow ease-motion-in-out'),
              )}
              style={split ? { width: 'var(--titlebar-split)' } : undefined}
            >
              {leftContent}
            </div>
          )}

          {/* 顶部的短分割线：与侧栏-内容区那条边界同 x，上下留白不顶满。
              纯装饰且不拦截拖拽 —— 真正的拖拽手柄仍在下方的侧栏边缘。 */}
          {split && (
            <span
              aria-hidden="true"
              data-titlebar-split-divider
              className="pointer-events-none absolute top-2.5 bottom-2.5 w-0.5 -translate-x-1/2 rounded-full bg-[hsl(var(--foreground)/0.2)]"
              style={{ left: 'var(--titlebar-split)' }}
            />
          )}

          {rightContent && (
            <div className={cn('flex min-w-0 shrink items-center gap-2 overflow-hidden', split ? 'pl-3' : leftContent ? 'pl-1' : 'pl-3')}>
              {rightContent}
            </div>
          )}

          <div className="min-w-2 flex-1" data-app-drag-region />

          <div className="flex h-full shrink-0 items-center gap-1">
            {projectOpenPath ? (
              <>
                <ProjectOpenTargetButton projectPath={projectOpenPath} />
                <GitEnvironmentPopover projectPath={projectOpenPath} todos={todos} />
              </>
            ) : null}
            {sidePanelAvailable && projectOpenPath ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={terminalDockOpen ? '收起底部终端' : '展开底部终端'}
                    aria-pressed={terminalDockOpen}
                    aria-keyshortcuts={terminalDockAria ?? undefined}
                    onClick={() => toggleTerminalDock(projectOpenPath)}
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-fast hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-35',
                      // 选中态沿用 NavRail 的口径：只提亮按钮底，图标保持前景色。
                      terminalDockOpen && 'bg-[hsl(var(--chrome-bg-hover))]',
                    )}
                  >
                    <SquareTerminalIcon className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>
                    {terminalDockOpen ? '收起底部终端' : '展开底部终端'}
                    {terminalDockHint ? ` · ${terminalDockHint}` : ''}
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : null}

            {sidePanelAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={sidePanelOpen ? '收起右侧面板' : '展开右侧面板'}
                    aria-keyshortcuts={sidePanelAria ?? undefined}
                    onClick={sidePanelOpen ? closeSidePanel : openSidePanel}
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-fast hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-35',
                    )}
                  >
                    <RoundedPanelIcon side="right" expanded={sidePanelOpen} className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>
                    {sidePanelOpen ? '收起右侧面板' : '展开右侧面板'}
                    {sidePanelHint ? ` · ${sidePanelHint}` : ''}
                  </p>
                </TooltipContent>
              </Tooltip>
            )}

            <DropdownMenu>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-foreground transition-all duration-normal hover:bg-muted/58 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.74]"
                    >
                      <ThemeIcon className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                </DropdownMenuTrigger>
                <TooltipContent side="bottom">
                  <p>主题切换</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="z-180 min-w-34">
                {themeOptions.map(({ value, label, Icon }) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => {
                      void setTheme(value);
                    }}
                    className={cn(currentTheme === value && 'option-row-selected')}
                  >
                    <div className="flex w-full items-center gap-2 rounded-sm px-0.5 py-0.5 text-ui-meta -mx-0.5 -my-0.5">
                      <Icon className="h-3.5 w-3.5" />
                      <span className={currentTheme === value ? 'font-medium text-foreground' : 'text-foreground/76'}>
                        {label}
                      </span>
                      {currentTheme === value && (
                        <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {presentation.windowControls && desktopBridge && (
            <div className="flex h-full items-stretch self-stretch">
              <button
                className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground transition-colors duration-fast hover:bg-muted/54 hover:text-foreground"
                onClick={() => void shellFacade.minimizeWindow().catch(() => {})}
              >
                <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
              <button
                className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground transition-colors duration-fast hover:bg-muted/54 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.72]"
                onClick={() => void shellFacade.toggleMaximizeWindow().catch(() => {})}
              >
                <MaximizeIcon restored={maximized} />
              </button>
              <button
                className="flex h-full w-12.5 items-center justify-center rounded-none text-foreground transition-colors duration-fast hover:bg-[hsl(var(--destructive-vivid)/0.92)] hover:text-white"
                onClick={() => void shellFacade.closeWindow().catch(() => {})}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      {/* 窗口命令菜单同样属于壳:浏览器形态不渲染这组必然失效的条目。 */}
      {presentation.windowControls && (
        <ContextMenuContent>
          <ContextMenuItem disabled={!maximized} onSelect={() => void shellFacade.toggleMaximizeWindow().catch(() => {})}>
            Restore
          </ContextMenuItem>
          <ContextMenuItem disabled>Move</ContextMenuItem>
          <ContextMenuItem disabled>Size</ContextMenuItem>
          <ContextMenuItem onSelect={() => void shellFacade.minimizeWindow().catch(() => {})}>
            Minimize
          </ContextMenuItem>
          <ContextMenuItem disabled={maximized} onSelect={() => void shellFacade.toggleMaximizeWindow().catch(() => {})}>
            Maximize
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void shellFacade.closeWindow().catch(() => {})}>
            Close
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
