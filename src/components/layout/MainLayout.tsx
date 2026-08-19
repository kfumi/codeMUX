import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useRef, useState, useCallback, useEffect, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { readLayoutPreferences, updateLayoutPreferences } from '../../lib/layoutPreferences';
import { LAYOUT_DIVIDER_CLASS } from '../../lib/layoutTokens';
import type { TodoItem } from '../../types/agent';
import { SidePanel } from '../workspace/SidePanel';
import { TooltipHint } from '../ui/tooltip';
import { RoundedPanelIcon } from './RoundedPanelIcon';
import { TitleBar, type TitleBarNavigation } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 300;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
}

function getInitialSidebarWidth(): { width: number; ratio: number } {
  const viewportWidth = typeof window === 'undefined' ? SIDEBAR_DEFAULT : Math.max(window.innerWidth, 1);
  const preferences = readLayoutPreferences();
  const ratio = preferences.sidebarRatio ?? SIDEBAR_DEFAULT / viewportWidth;
  return { width: clampSidebarWidth(viewportWidth * ratio), ratio };
}

interface MainLayoutProps {
  sidebar?: ReactNode;
  children: ReactNode;
  headerContent?: ReactNode;
  sidebarAccessory?: ReactNode;
  titleBarNavigation?: TitleBarNavigation;
  projectOpenPath?: string | null;
  sidePanelAvailable?: boolean;
  sidePanelProjectPath?: string | null;
  sidePanelScopeId?: string;
  todos?: TodoItem[];
}

export function MainLayout({
  sidebar,
  children,
  headerContent,
  sidebarAccessory,
  titleBarNavigation,
  projectOpenPath,
  sidePanelAvailable = true,
  sidePanelProjectPath,
  sidePanelScopeId = 'global',
  todos,
}: MainLayoutProps) {
  const initialSidebar = getInitialSidebarWidth();
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebar.width);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDragging = useRef(false);
  const sidebarRatioRef = useRef(initialSidebar.ratio);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarExistsRef = useRef(false);
  const sidebarInstant = sidebar != null && !sidebarExistsRef.current;

  useEffect(() => {
    let frameId: number | null = null;
    const resizeSidebarWithWindow = () => {
      if (sidebarDragging.current) return;
      if (typeof window.requestAnimationFrame !== 'function') {
        setSidebarWidth(clampSidebarWidth(window.innerWidth * sidebarRatioRef.current));
        return;
      }

      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        if (!sidebarDragging.current) {
          setSidebarWidth(clampSidebarWidth(window.innerWidth * sidebarRatioRef.current));
        }
      });
    };

    window.addEventListener('resize', resizeSidebarWithWindow);
    return () => {
      window.removeEventListener('resize', resizeSidebarWithWindow);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, []);

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
      const width = clampSidebarWidth(moveEvent.clientX);
      sidebarRatioRef.current = width / Math.max(window.innerWidth, 1);
      setSidebarWidth(width);
    };

    const onUp = () => {
      sidebarDragging.current = false;
      setSidebarResizing(false);
      updateLayoutPreferences({ sidebarRatio: sidebarRatioRef.current });
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
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground/58 transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45',
        )}
      >
        <RoundedPanelIcon side="left" expanded={!sidebarCollapsed} className="h-4 w-4" />
      </button>
    </TooltipHint>
  ) : null;

  const sidebarControls = sidebarToggleButton ? (
    <div className="flex items-center gap-1">
      {sidebarToggleButton}
      {titleBarNavigation ? (
        <div className="flex items-center gap-0.5">
          <TooltipHint content="后退">
            <button
              type="button"
              aria-label="后退"
              disabled={!titleBarNavigation.canGoBack}
              onClick={titleBarNavigation.onBack}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/58 transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/22 disabled:hover:bg-transparent"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </TooltipHint>
          <TooltipHint content="前进">
            <button
              type="button"
              aria-label="前进"
              disabled={!titleBarNavigation.canGoForward}
              onClick={titleBarNavigation.onForward}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/58 transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/22 disabled:hover:bg-transparent"
            >
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </TooltipHint>
        </div>
      ) : null}
      {sidebarAccessory}
    </div>
  ) : null;

  return (
    <div className="app-shell flex h-screen bg-background text-foreground">
      {sidebar != null && !sidebarCollapsed && (
        <div className="fixed left-2 top-2 z-40">
          {sidebarControls}
        </div>
      )}

      {sidebar != null && (
        <aside
          className={cn(
            `relative shrink-0 overflow-hidden border-r ${LAYOUT_DIVIDER_CLASS} bg-[hsl(var(--surface-2)/0.88)] shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.04)] backdrop-blur-xl`,
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

      <section className="flex min-w-0 flex-1 flex-col bg-[hsl(var(--background))]">
        <TitleBar
          leftContent={sidebarCollapsed ? sidebarControls : undefined}
          rightContent={headerContent}
          projectOpenPath={projectOpenPath}
          sidePanelAvailable={sidePanelAvailable}
          todos={todos}
        />

        <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--sidebar-bg))]">
          <div className="flex min-w-110 flex-1 flex-col bg-[hsl(var(--background))]">{children}</div>
          <SidePanel
            projectPath={sidePanelProjectPath}
            scopeId={sidePanelScopeId}
            isVisible={sidePanelAvailable}
          />
        </main>
      </section>
    </div>
  );
}
