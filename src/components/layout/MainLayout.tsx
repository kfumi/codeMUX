import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useRef, useState, useCallback, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { SidePanel } from '../workspace/SidePanel';
import { TooltipHint } from '../ui/tooltip';
import { TitleBar } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 300;

interface MainLayoutProps {
  sidebar?: ReactNode;
  children: ReactNode;
  headerContent?: ReactNode;
  sidebarAccessory?: ReactNode;
  titleBarControls?: ReactNode;
  projectOpenPath?: string | null;
  sidePanelAvailable?: boolean;
  sidePanelProjectPath?: string | null;
  sidePanelScopeId?: string;
}

export function MainLayout({
  sidebar,
  children,
  headerContent,
  sidebarAccessory,
  titleBarControls,
  projectOpenPath,
  sidePanelAvailable = true,
  sidePanelProjectPath,
  sidePanelScopeId = 'global',
}: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDragging = useRef(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarExistsRef = useRef(false);
  const sidebarInstant = sidebar != null && !sidebarExistsRef.current;

  useLayoutEffect(() => {
    sidebarExistsRef.current = sidebar != null;
  }, [sidebar != null]);

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

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => !value);
  }, []);

  const sidebarToggleButton = sidebar != null ? (
    <TooltipHint content={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
      <button
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        className={cn(
          'flex h-7 w-8 shrink-0 items-center justify-center rounded-md transition-all duration-150',
          sidebarCollapsed
            ? 'text-foreground/58 hover:bg-muted/58 hover:text-foreground'
            : 'text-[hsl(var(--sidebar-fg))]/58 hover:bg-[hsl(var(--sidebar-muted))]/80 hover:text-[hsl(var(--sidebar-fg))]',
        )}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="h-3.5 w-3.5" />
        ) : (
          <PanelLeftClose className="h-3.5 w-3.5" />
        )}
      </button>
    </TooltipHint>
  ) : null;

  const sidebarControls = sidebarToggleButton ? (
    <div className="flex items-center gap-1">
      {sidebarToggleButton}
      {sidebarAccessory}
    </div>
  ) : null;

  return (
    <div className={cn('app-shell flex h-screen text-foreground', sidebar != null && !sidebarCollapsed ? 'bg-[hsl(var(--sidebar-bg))]' : 'bg-background')}>
      {sidebar != null && !sidebarCollapsed && (
        <div className="fixed left-2 top-2 z-40">
          {sidebarControls}
        </div>
      )}

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

      <section className={cn('flex min-w-0 flex-1 flex-col bg-[hsl(var(--background))]', sidebar != null && !sidebarCollapsed && 'overflow-hidden rounded-l-xl')}>
        <TitleBar
          leftContent={sidebarCollapsed ? sidebarControls : undefined}
          rightContent={headerContent}
          controlsContent={titleBarControls}
          projectOpenPath={projectOpenPath}
          sidePanelAvailable={sidePanelAvailable}
        />

        <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--sidebar-bg))]">
          <div className="flex min-w-[440px] flex-1 flex-col bg-[hsl(var(--background))]">{children}</div>
          {sidePanelAvailable && <SidePanel projectPath={sidePanelProjectPath} scopeId={sidePanelScopeId} />}
        </main>
      </section>
    </div>
  );
}
