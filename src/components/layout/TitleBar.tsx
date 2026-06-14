import { type MouseEvent, useEffect, useState } from 'react';
import { Minus, PanelLeftClose, PanelLeftOpen, Sun, Moon, Monitor, X } from 'lucide-react';

import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';

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
  typeof window !== 'undefined' && typeof (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

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
  const [themeOpen, setThemeOpen] = useState(false);
  const currentTheme = useSettingsStore((state) => state.config?.theme || 'System');
  const setTheme = useSettingsStore((state) => state.setTheme);

  const ThemeIcon = currentTheme === 'Dark' ? Moon : currentTheme === 'Light' ? Sun : Monitor;

  useEffect(() => {
    if (!themeOpen) return;
    const close = () => setThemeOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [themeOpen]);

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

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-[34px] shrink-0 select-none items-center border-b border-border bg-background pl-0 pr-0"
      onContextMenu={handleContextMenu}
    >
      {onToggleSidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleSidebar}
              className="ml-1 flex h-[22px] w-[28px] shrink-0 items-center justify-center rounded-md text-foreground/70 transition-all duration-150 hover:bg-foreground/10 hover:text-foreground"
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}</p>
          </TooltipContent>
        </Tooltip>
      )}

      <div className="flex items-center gap-2.5 pl-2.5">
        <div className="relative h-2 w-2 rounded-full bg-gradient-to-br from-[hsl(180_80%_50%)] to-[hsl(215_100%_60%)] shadow-[0_0_8px_hsl(215_100%_60%/0.4)]" />
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          codeMUX
        </span>
      </div>

      <div className="flex-1" />

      <div className="relative flex h-full items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => { e.stopPropagation(); setThemeOpen((v) => !v); }}
              className="flex h-[22px] w-[28px] shrink-0 items-center justify-center rounded-md text-foreground/70 transition-all duration-150 hover:bg-foreground/10 hover:text-foreground"
            >
              <ThemeIcon className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>主题：（点击切换）</p>
          </TooltipContent>
        </Tooltip>

        {themeOpen && (
          <div
            className="absolute top-full right-0 z-50 mt-0.5 min-w-[120px] rounded-lg border border-border bg-popover p-1 shadow-lg animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            {([
              { value: 'Light' as Theme, label: '浅色', Icon: Sun },
              { value: 'Dark' as Theme, label: '深色', Icon: Moon },
              { value: 'System' as Theme, label: '跟随系统', Icon: Monitor },
            ]).map(({ value, label, Icon }) => (
              <button
                key={value}
                onClick={() => { setTheme(value); setThemeOpen(false); }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${
                  currentTheme === value
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-foreground/70 hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {currentTheme === value && (
                  <span className="ml-auto text-[10px] text-primary">✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {appWindow && (
        <div className="flex h-full items-stretch self-stretch">
          <button
            className="flex h-full w-[46px] items-center justify-center rounded-none text-foreground/70 transition-colors duration-150 hover:bg-muted hover:text-foreground"
            onClick={() => appWindow.minimize()}
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            className="flex h-full w-[46px] items-center justify-center rounded-none text-foreground/70 transition-colors duration-150 hover:bg-muted hover:text-foreground"
            onClick={() => appWindow.toggleMaximize()}
          >
            <MaximizeIcon restored={maximized} />
          </button>
          <button
            className="flex h-full w-[50px] items-center justify-center rounded-none text-foreground/70 transition-colors duration-150 hover:bg-[hsl(var(--destructive)/0.92)] hover:text-white"
            onClick={() => appWindow.close()}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
}
