import { type MouseEvent, useEffect, useState } from 'react';
import { Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun, X } from 'lucide-react';

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
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function TitleBar({ sidebarCollapsed, onToggleSidebar }: TitleBarProps) {
  const [appWindow, setAppWindow] = useState<AppWindowLike | null>(null);
  const [maximized, setMaximized] = useState(false);
  const currentTheme = useSettingsStore((state) => state.config?.theme || 'System');
  const setTheme = useSettingsStore((state) => state.setTheme);

  const ThemeIcon = currentTheme === 'Dark' ? Moon : currentTheme === 'Light' ? Sun : Monitor;

  useEffect(() => {
    if (!isTauriWindowAvailable()) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow() as AppWindowLike;

      if (disposed) {
        return;
      }

      setAppWindow(currentWindow);
      setMaximized(await currentWindow.isMaximized());

      const unlisten = await currentWindow.onResized(() => {
        currentWindow.isMaximized().then((value) => {
          if (!disposed) {
            setMaximized(value);
          }
        });
      });

      cleanup = unlisten;
    };

    void setup();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  const handleContextMenu = async (event: MouseEvent) => {
    if (!appWindow) {
      return;
    }

    event.preventDefault();

    const { Menu } = await import('@tauri-apps/api/menu');
    const menu = await Menu.new({
      items: [
        {
          id: 'restore',
          text: 'Restore',
          enabled: maximized,
          action: () => {
            if (maximized) {
              appWindow.unmaximize();
            }
          },
        },
        { id: 'move', text: 'Move', enabled: false },
        { id: 'size', text: 'Size', enabled: false },
        {
          id: 'minimize',
          text: 'Minimize',
          action: () => appWindow.minimize(),
        },
        {
          id: 'maximize',
          text: 'Maximize',
          enabled: !maximized,
          action: () => {
            if (!maximized) {
              appWindow.maximize();
            }
          },
        },
        { id: 'separator', text: '', enabled: false },
        {
          id: 'close',
          text: 'Close',
          accelerator: 'Alt+F4',
          action: () => appWindow.close(),
        },
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
      className="surface-panel surface-panel-muted relative z-20 flex h-9.5 shrink-0 select-none items-center border-b border-[hsl(var(--sidebar-border))] pl-0 pr-0 border-x-0! border-t-0!"
      onContextMenu={handleContextMenu}
    >
      {onToggleSidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleSidebar}
              className="ml-2 flex h-7 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/62 transition-all duration-150 hover:bg-muted/60 hover:text-foreground"
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{sidebarCollapsed ? '展开侧栏' : '收起侧栏'}</p>
          </TooltipContent>
        </Tooltip>
      )}

      <div className="flex items-center gap-2.5 pl-3">
        <div className="relative h-2.5 w-2.5 rounded-full bg-linear-to-br from-[hsl(var(--primary))] to-[hsl(var(--primary))/0.65] shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground/88">
          codeMUX
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex h-full items-center">
        <DropdownMenu
          align="right"
          panelClassName="z-[180] min-w-[136px]"
          trigger={(
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/62 transition-all duration-200 hover:bg-muted/60 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.86]"
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
            className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground/62 transition-colors duration-150 hover:bg-muted/60 hover:text-foreground"
            onClick={() => appWindow.minimize()}
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            className="flex h-full w-11.5 items-center justify-center rounded-none text-foreground/62 transition-colors duration-150 hover:bg-muted/60 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.82]"
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
