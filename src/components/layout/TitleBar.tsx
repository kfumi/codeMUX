import { type ReactNode, useEffect, useState } from 'react';
import {
  Check,
  Minus,
  Monitor,
  Moon,
  Sun,
  X,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { desktopBridge } from '../../lib/desktop-bridge';
import { shellFacade } from '../../lib/facades/shell-facade';
import { useSidePanelStore } from '../../stores/sidePanelStore';
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
}

export function TitleBar({
  leftContent,
  rightContent,
  projectOpenPath,
  sidePanelAvailable = true,
  todos = EMPTY_TODOS,
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const currentTheme = useSettingsStore((state) => state.config?.theme || 'System');
  const setTheme = useSettingsStore((state) => state.setTheme);
  const sidePanelOpen = useSidePanelStore((state) => state.isOpen);
  const openSidePanel = useSidePanelStore((state) => state.openPanel);
  const closeSidePanel = useSidePanelStore((state) => state.closePanel);

  const ThemeIcon = currentTheme === 'Dark' ? Moon : currentTheme === 'Light' ? Sun : Monitor;

  // 自绘标题栏(工单 09):窗口命令走壳桥,最大化态经 main 的
  // window-maximize-changed 桌面事件订阅;桥缺失(纯 Web)时不渲染窗口按钮。
  useEffect(() => {
    if (!desktopBridge) return;

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
  }, []);

  const themeOptions: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
    { value: 'Light', label: '浅色', Icon: Sun },
    { value: 'Dark', label: '深色', Icon: Moon },
    { value: 'System', label: '跟随系统', Icon: Monitor },
  ];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-app-drag-region
          className="relative z-20 flex h-12 shrink-0 select-none items-stretch border-b border-border bg-[hsl(var(--background))]"
        >
          {leftContent && (
            <div className="flex h-full items-center pl-2">
              {leftContent}
            </div>
          )}

          {rightContent && (
            <div className={cn('flex min-w-0 shrink items-center gap-2 overflow-hidden', leftContent ? 'pl-1' : 'pl-3')}>
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
            {sidePanelAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={sidePanelOpen ? '收起右侧面板' : '展开右侧面板'}
                    onClick={sidePanelOpen ? closeSidePanel : openSidePanel}
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-35',
                    )}
                  >
                    <RoundedPanelIcon side="right" expanded={sidePanelOpen} className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{sidePanelOpen ? '收起右侧面板' : '展开右侧面板'}</p>
                </TooltipContent>
              </Tooltip>
            )}

            <DropdownMenu>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-foreground transition-all duration-200 hover:bg-muted/58 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.74]"
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

          {desktopBridge && (
            <div className="flex h-full items-stretch self-stretch">
              <button
                className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground transition-colors duration-150 hover:bg-muted/54 hover:text-foreground"
                onClick={() => void shellFacade.minimizeWindow().catch(() => {})}
              >
                <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
              <button
                className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground transition-colors duration-150 hover:bg-muted/54 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.72]"
                onClick={() => void shellFacade.toggleMaximizeWindow().catch(() => {})}
              >
                <MaximizeIcon restored={maximized} />
              </button>
              <button
                className="flex h-full w-12.5 items-center justify-center rounded-none text-foreground transition-colors duration-150 hover:bg-[hsl(var(--destructive)/0.92)] hover:text-white"
                onClick={() => void shellFacade.closeWindow().catch(() => {})}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>
          )}
        </div>
      </ContextMenuTrigger>

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
    </ContextMenu>
  );
}
