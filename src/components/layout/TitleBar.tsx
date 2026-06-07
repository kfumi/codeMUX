import { useEffect, useState, MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Menu } from '@tauri-apps/api/menu';
import { Minus, X } from 'lucide-react';

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
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [appWindow]);

  const handleContextMenu = async (e: MouseEvent) => {
    e.preventDefault();
    const menu = await Menu.new({
      items: [
        {
          id: 'restore',
          text: '还原(R)',
          enabled: maximized,
          action: () => { if (maximized) appWindow.unmaximize(); },
        },
        { id: 'move', text: '移动(M)', enabled: false },
        { id: 'size', text: '大小(S)', enabled: false },
        {
          id: 'minimize',
          text: '最小化(N)',
          action: () => appWindow.minimize(),
        },
        {
          id: 'maximize',
          text: '最大化(X)',
          enabled: !maximized,
          action: () => { if (!maximized) appWindow.maximize(); },
        },
        { id: 'separator', text: '', enabled: false },
        {
          id: 'close',
          text: '关闭(C)',
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
      className="flex items-center h-[38px] px-4 select-none shrink-0 bg-[hsl(var(--sidebar-bg))] border-b border-[hsl(var(--sidebar-border))]"
      onContextMenu={handleContextMenu}
    >
      {/* App brand */}
      <div className="flex items-center gap-2.5">
        <div className="relative w-2 h-2 rounded-full bg-gradient-to-br from-[hsl(180_80%_50%)] to-[hsl(215_100%_60%)] shadow-[0_0_8px_hsl(215_100%_60%/0.4)]" />
        <span
          className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[hsl(var(--sidebar-fg))]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          codeMUX
        </span>
      </div>

      {/* Spacer — drag region */}
      <div className="flex-1" />

      {/* Window controls — far right */}
      <div className="flex items-center -mr-2">
        <button
          className="h-[38px] w-[46px] flex items-center justify-center text-[hsl(var(--sidebar-fg))]/40 hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))] transition-all duration-150"
          onClick={() => appWindow.minimize()}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          className="h-[38px] w-[46px] flex items-center justify-center text-[hsl(var(--sidebar-fg))]/40 hover:text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-accent))] transition-all duration-150"
          onClick={() => appWindow.toggleMaximize()}
        >
          <MaximizeIcon restored={maximized} />
        </button>
        <button
          className="h-[38px] w-[46px] flex items-center justify-center text-[hsl(var(--sidebar-fg))]/40 hover:text-white hover:bg-[hsl(var(--destructive)/0.85)] transition-all duration-150"
          onClick={() => appWindow.close()}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
