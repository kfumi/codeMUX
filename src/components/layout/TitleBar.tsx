import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import {
  Minus,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Sun,
  X,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

type AppWindowLike = {
  isMaximized(): Promise<boolean>;
  onResized(listener: () => void): Promise<() => void>;
  minimize(): Promise<void> | void;
  maximize(): Promise<void> | void;
  unmaximize(): Promise<void> | void;
  toggleMaximize(): Promise<void> | void;
  close(): Promise<void> | void;
};

const isTauriWindowAvailable = () =>
  typeof window !== 'undefined'
  && typeof (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

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

interface TitleBarProps {
  leftContent?: ReactNode;
  rightContent?: ReactNode;
  sidePanelAvailable?: boolean;
}

export function TitleBar({
  leftContent,
  rightContent,
  sidePanelAvailable = true,
}: TitleBarProps) {
  const [appWindow, setAppWindow] = useState<AppWindowLike | null>(null);
  const [maximized, setMaximized] = useState(false);
  const currentTheme = useSettingsStore((state) => state.config?.theme || 'System');
  const setTheme = useSettingsStore((state) => state.setTheme);
  const sidePanelOpen = useSidePanelStore((state) => state.isOpen);
  const openSidePanel = useSidePanelStore((state) => state.openPanel);
  const closeSidePanel = useSidePanelStore((state) => state.closePanel);

  const ThemeIcon = currentTheme === 'Dark' ? Moon : currentTheme === 'Light' ? Sun : Monitor;

  useEffect(() => {
    if (!isTauriWindowAvailable()) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow() as AppWindowLike;

      if (disposed) return;

      setAppWindow(currentWindow);
      setMaximized(await currentWindow.isMaximized());

      cleanup = await currentWindow.onResized(() => {
        currentWindow.isMaximized().then((value) => {
          if (!disposed) setMaximized(value);
        });
      });
    };

    void setup();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  const handleContextMenu = async (event: MouseEvent) => {
    if (!appWindow) return;

    event.preventDefault();

    const { Menu } = await import('@tauri-apps/api/menu');
    const menu = await Menu.new({
      items: [
        { id: 'restore', text: 'Restore', enabled: maximized, action: () => maximized && appWindow.unmaximize() },
        { id: 'move', text: 'Move', enabled: false },
        { id: 'size', text: 'Size', enabled: false },
        { id: 'minimize', text: 'Minimize', action: () => appWindow.minimize() },
        { id: 'maximize', text: 'Maximize', enabled: !maximized, action: () => !maximized && appWindow.maximize() },
        { id: 'separator', text: '', enabled: false },
        { id: 'close', text: 'Close', accelerator: 'Alt+F4', action: () => appWindow.close() },
      ],
    });

    await menu.popup();
  };

  const themeOptions: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
    { value: 'Light', label: '浅色', Icon: Sun },
    { value: 'Dark', label: '深色', Icon: Moon },
    { value: 'System', label: '跟随系统', Icon: Monitor },
  ];

  return (
    <div
      data-tauri-drag-region
      className="relative z-20 flex h-12 shrink-0 select-none items-stretch border-b-2 border-[hsl(var(--border))]/30 bg-[hsl(var(--background))]"
      onContextMenu={handleContextMenu}
    >
      {leftContent && (
        <div className="flex h-full items-center pl-2">
          {leftContent}
        </div>
      )}

      {rightContent && (
        <div className={cn('flex min-w-0 items-center gap-2', leftContent ? 'pl-1' : 'pl-3')}>
          {rightContent}
        </div>
      )}

      <div className="flex-1" data-tauri-drag-region />

      <div className="flex h-full items-center">
        {sidePanelAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={sidePanelOpen ? closeSidePanel : openSidePanel}
                className={cn(
                  'flex h-7 w-8 shrink-0 items-center justify-center rounded-md transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-35',
                  'text-foreground/45 hover:bg-muted/45 hover:text-foreground',
                )}
              >
                {sidePanelOpen ? (
                  <PanelRightClose className="h-3.5 w-3.5" />
                ) : (
                  <PanelRightOpen className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{sidePanelOpen ? '收起右侧面板' : '展开右侧面板'}</p>
            </TooltipContent>
          </Tooltip>
        )}

        <DropdownMenu
          align="right"
          panelClassName="z-[180] min-w-[136px]"
          trigger={(
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-foreground/58 transition-all duration-200 hover:bg-muted/58 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.74]"
                >
                  <ThemeIcon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>主题切换</p>
              </TooltipContent>
            </Tooltip>
          )}
        >
          {themeOptions.map(({ value, label, Icon }) => (
            <DropdownMenuItem
              key={value}
              onClick={() => {
                void setTheme(value);
              }}
            >
              <div className="flex w-full items-center gap-2 text-[12px]">
                <Icon className="h-3.5 w-3.5" />
                <span className={currentTheme === value ? 'font-medium text-foreground' : 'text-foreground/76'}>
                  {label}
                </span>
                {currentTheme === value && (
                  <span className="ml-auto text-[10px] text-primary">+</span>
                )}
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      </div>

      {appWindow && (
        <div className="flex h-full items-stretch self-stretch">
          <button
            className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground/62 transition-colors duration-150 hover:bg-muted/54 hover:text-foreground"
            onClick={() => appWindow.minimize()}
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground/62 transition-colors duration-150 hover:bg-muted/54 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.72]"
            onClick={() => appWindow.toggleMaximize()}
          >
            <MaximizeIcon restored={maximized} />
          </button>
          <button
            className="flex h-full w-12.5 items-center justify-center rounded-none text-foreground/62 transition-colors duration-150 hover:bg-[hsl(var(--destructive)/0.92)] hover:text-white"
            onClick={() => appWindow.close()}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
}
