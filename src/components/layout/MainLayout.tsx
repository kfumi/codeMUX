import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ReactNode, useCallback, useRef, useState } from 'react';

import { usePreviewStore } from '../../stores/previewStore';
import { TitleBar } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 260;

interface MainLayoutProps {
  sidebar: ReactNode | ((onToggleCollapse: () => void) => ReactNode);
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDragging = useRef(false);

  const previewOpen = usePreviewStore((state) => state.isOpen);
  const previewWidth = usePreviewStore((state) => state.panelWidth);
  const setPreviewWidth = usePreviewStore((state) => state.setPanelWidth);
  const previewDragging = useRef(false);

  const handleSidebarMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    sidebarDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvent.clientX));
      setSidebarWidth(width);
    };

    const onUp = () => {
      sidebarDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handlePreviewMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startWidth = previewWidth;

    const onMove = (moveEvent: MouseEvent) => {
      if (!previewDragging.current) return;
      const delta = startX - moveEvent.clientX;
      setPreviewWidth(startWidth + delta);
    };

    const onUp = () => {
      previewDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [previewWidth, setPreviewWidth]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => !value);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background">
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="m-1 self-start rounded-lg p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground"
            title="展开侧边栏"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {!sidebarCollapsed && (
          <>
            <aside
              className="relative shrink-0 rounded-br-2xl rounded-tr-2xl border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-bg))] sidebar-grain"
              style={{ width: sidebarWidth }}
            >
              <div className="relative z-10 flex h-full flex-col">
                {typeof sidebar === 'function' ? sidebar(toggleSidebar) : sidebar}
              </div>
            </aside>

            <div className="group relative w-1 shrink-0 cursor-col-resize" onMouseDown={handleSidebarMouseDown}>
              <div className="absolute inset-y-0 -left-0.5 w-2 transition-colors duration-200 group-hover:bg-primary/15" />
              <div className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-transparent transition-all duration-300 group-hover:bg-primary/30" />
              <button
                onClick={toggleSidebar}
                className="absolute -left-3 top-1 rounded-md border border-border bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm transition-all duration-200 group-hover:opacity-100 hover:bg-muted/50 hover:text-foreground"
                title="收起侧边栏"
              >
                <PanelLeftClose className="h-3 w-3" />
              </button>
            </div>
          </>
        )}

        <main className="flex flex-1 overflow-hidden bg-background">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          {preview && previewOpen && (
            <>
              <div className="group relative w-1 shrink-0 cursor-col-resize" onMouseDown={handlePreviewMouseDown}>
                <div className="absolute inset-y-0 -left-0.5 w-2 transition-colors duration-200 group-hover:bg-primary/15" />
                <div className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-transparent transition-all duration-300 group-hover:bg-primary/30" />
              </div>
              {preview}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
