import { useRef, useState, useCallback, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { usePreviewStore } from '../../stores/previewStore';
import { TitleBar } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 300;

interface MainLayoutProps {
  sidebar?: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
  headerContent?: ReactNode;
  previewAvailable?: boolean;
}

export function MainLayout({ sidebar, children, preview, headerContent, previewAvailable = !!preview }: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDragging = useRef(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarExistsRef = useRef(false);
  const sidebarInstant = sidebar != null && !sidebarExistsRef.current;

  useLayoutEffect(() => {
    sidebarExistsRef.current = sidebar != null;
  }, [sidebar != null]);

  const previewOpen = usePreviewStore((state) => state.isOpen);
  const previewWidth = usePreviewStore((state) => state.panelWidth);
  const setPreviewWidth = usePreviewStore((state) => state.setPanelWidth);
  const setResizing = usePreviewStore((state) => state.setResizing);
  const previewDragging = useRef(false);

  const handleSidebarMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    sidebarDragging.current = true;
    setSidebarResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvent.clientX));
      setSidebarWidth(width);
    };

    const onUp = () => {
      sidebarDragging.current = false;
      setSidebarResizing(false);
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
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startWidth = previewWidth;

    const onMove = (moveEvent: MouseEvent) => {
      if (!previewDragging.current) return;
      const delta = startX - moveEvent.clientX;
      setPreviewWidth(startWidth + delta, sidebarCollapsed ? 0 : sidebarWidth);
    };

    const onUp = () => {
      previewDragging.current = false;
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [previewWidth, setPreviewWidth, setResizing, sidebarWidth, sidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => !value);
  }, []);

  return (
    <div className="app-shell flex h-screen flex-col bg-background text-foreground">
      <TitleBar
        sidebarCollapsed={sidebar ? sidebarCollapsed : true}
        sidebarWidth={sidebarWidth}
        onToggleSidebar={sidebar ? toggleSidebar : undefined}
        sidebarInstant={sidebarInstant}
        rightContent={headerContent}
        previewAvailable={previewAvailable}
      />

      <div className="relative z-10 flex flex-1 overflow-hidden">

        {sidebar != null && (
          <aside
            className={cn(
              'relative shrink-0 overflow-hidden rounded-none bg-[hsl(var(--sidebar-bg))] sidebar-grain shadow-[0.5px_0_0_0_hsl(var(--sidebar-border)/0.5)]',
              sidebarResizing ? 'transition-none' : 'transition-[width,opacity] duration-300 ease-in-out',
            )}
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth, opacity: sidebarCollapsed ? 0 : 1, transitionDuration: sidebarInstant ? '0ms' : undefined }}
          >
            <div className="relative z-10 flex h-full flex-col" style={{ width: sidebarWidth }}>
              {sidebar}
            </div>
            <div
              className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
              onMouseDown={handleSidebarMouseDown}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-200 group-hover:bg-primary/22" />
            </div>
          </aside>
        )}

        {/* 圆角缺口填充：用侧边栏背景色覆盖主区域左侧圆角露出的背景 */}
        {sidebar != null && !sidebarCollapsed && (
          <div
            className="absolute bottom-0 z-0 pointer-events-none bg-[hsl(var(--sidebar-bg))] transition-[left] duration-300 ease-in-out"
            style={{ left: sidebarWidth, width: '0.5rem', height: '0.5rem', transitionDuration: sidebarInstant ? '0ms' : undefined }}
          />
        )}
        <main className={cn('relative z-1 flex flex-1 bg-[hsl(var(--background))] transition-[background] duration-300', sidebar != null && 'rounded-bl-xl')}>
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          {preview && previewOpen && (
            <div
              className="group absolute inset-y-0 z-20 w-2 cursor-col-resize"
              style={{ right: previewWidth - 4 }}
              onMouseDown={handlePreviewMouseDown}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-200 group-hover:bg-primary/22" />
            </div>
          )}
          {preview}
        </main>
      </div>

    </div>
  );
}
