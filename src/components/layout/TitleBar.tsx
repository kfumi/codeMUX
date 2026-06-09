import { type MouseEvent, useEffect, useState } from 'react';
import { Minus, X } from 'lucide-react';

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
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="2.5" y="0.5" width="7" height="7" rx="1" />
        <rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" fillOpacity="0.08" />
      </svg>
    );
  }

  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
    </svg>
  );
}

export function TitleBar() {
  const [appWindow, setAppWindow] = useState<AppWindowLike | null>(null);
  const [maximized, setMaximized] = useState(false);

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
      className="flex h-[38px] shrink-0 select-none items-center border-b border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-bg))] px-4"
      onContextMenu={handleContextMenu}
    >
      <div className="flex items-center gap-2.5">
        <div className="relative h-2 w-2 rounded-full bg-gradient-to-br from-[hsl(180_80%_50%)] to-[hsl(215_100%_60%)] shadow-[0_0_8px_hsl(215_100%_60%/0.4)]" />
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--sidebar-fg))]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          codeMUX
        </span>
      </div>

      <div className="flex-1" />

      {appWindow && (
        <div className="-mr-2 flex items-center">
          <button
            className="flex h-[38px] w-[46px] items-center justify-center text-[hsl(var(--sidebar-fg))]/40 transition-all duration-150 hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-fg))]"
            onClick={() => appWindow.minimize()}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-[38px] w-[46px] items-center justify-center text-[hsl(var(--sidebar-fg))]/40 transition-all duration-150 hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-fg))]"
            onClick={() => appWindow.toggleMaximize()}
          >
            <MaximizeIcon restored={maximized} />
          </button>
          <button
            className="flex h-[38px] w-[46px] items-center justify-center text-[hsl(var(--sidebar-fg))]/40 transition-all duration-150 hover:bg-[hsl(var(--destructive)/0.85)] hover:text-white"
            onClick={() => appWindow.close()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
