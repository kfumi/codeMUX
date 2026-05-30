import { ReactNode, useCallback, useRef, useState } from 'react';
import { TitleBar } from './TitleBar';
import { usePreviewStore } from '../../stores/previewStore';
import { PanelLeftOpen, PanelLeftClose } from 'lucide-react';

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

  const { isOpen: previewOpen, panelWidth: previewWidth, setPanelWidth: setPreviewWidth } = usePreviewStore();
  const previewDragging = useRef(false);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(w);
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

  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    previewDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const startWidth = previewWidth;

    const onMove = (ev: MouseEvent) => {
      if (!previewDragging.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.min(800, Math.max(300, startWidth + delta));
      setPreviewWidth(newWidth);
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
    setSidebarCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Title bar — spans full width, window controls on far right */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar toggle button (visible when collapsed) */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="p-1.5 m-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors self-start"
            title="展开侧边栏"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {/* Sidebar — follows theme */}
        {!sidebarCollapsed && (
          <>
            <aside
              className="flex flex-col bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))] shrink-0 relative sidebar-grain rounded-tr-2xl rounded-br-2xl"
              style={{ width: sidebarWidth }}
            >
              <div className="relative z-10 flex flex-col h-full">
                {typeof sidebar === 'function' ? sidebar(toggleSidebar) : sidebar}
              </div>
            </aside>

            {/* Sidebar drag handle + collapse button */}
            <div
              className="w-1 shrink-0 cursor-col-resize group relative"
              onMouseDown={handleSidebarMouseDown}
            >
              <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
              <button
                onClick={toggleSidebar}
                className="absolute top-1 -left-3 p-0.5 rounded bg-background border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100"
                title="收起侧边栏"
              >
                <PanelLeftClose className="h-3 w-3" />
              </button>
            </div>
          </>
        )}

        {/* Main content area */}
        <main className="flex-1 flex overflow-hidden bg-background">
          <div className="flex-1 flex flex-col min-w-0">
            {children}
          </div>
          {preview && previewOpen && (
            <>
              {/* Preview drag handle */}
              <div
                className="w-1 shrink-0 cursor-col-resize group relative"
                onMouseDown={handlePreviewMouseDown}
              >
                <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
              </div>
              {preview}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
