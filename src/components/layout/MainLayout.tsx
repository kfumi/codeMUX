import { ReactNode, useCallback, useRef, useState } from 'react';
import { TitleBar } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 260;

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(w);
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Title bar — spans full width, window controls on far right */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — follows theme */}
        <aside
          className="flex flex-col bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))] shrink-0 relative sidebar-grain rounded-tr-2xl rounded-br-2xl"
          style={{ width: sidebarWidth }}
        >
          <div className="relative z-10 flex flex-col h-full">
            {sidebar}
          </div>
        </aside>

        {/* Drag handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize group relative"
          onMouseDown={handleMouseDown}
        >
          <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
        </div>

        {/* Main content area */}
        <main className="flex-1 flex overflow-hidden bg-background">
          <div className="flex-1 flex flex-col min-w-0">
            {children}
          </div>
          {preview}
        </main>
      </div>
    </div>
  );
}
