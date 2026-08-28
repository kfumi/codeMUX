import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useRef, useState, useCallback, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { readLayoutPreferences, updateLayoutPreferences } from '../../lib/layoutPreferences';
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

function getInitialSidebarWidth(): number {
  const viewportWidth = typeof window === 'undefined' ? SIDEBAR_DEFAULT : Math.max(window.innerWidth, 1);
  const preferences = readLayoutPreferences();
  // 旧版本持久化的是比例，这里一次性换算成绝对宽度；此后宽度只随手动拖拽变化，
  // 窗口最大化/还原不会改变侧栏宽度
  const stored = preferences.sidebarWidth
    ?? (preferences.sidebarRatio ? viewportWidth * preferences.sidebarRatio : undefined);
  return clampSidebarWidth(stored ?? SIDEBAR_DEFAULT);
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
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDragging = useRef(false);
  const sidebarWidthRef = useRef(sidebarWidth);
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
      const width = clampSidebarWidth(moveEvent.clientX);
      sidebarWidthRef.current = width;
      setSidebarWidth(width);
    };

    const onUp = () => {
      sidebarDragging.current = false;
      setSidebarResizing(false);
      updateLayoutPreferences({ sidebarWidth: sidebarWidthRef.current });
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
            `relative shrink-0 overflow-hidden bg-[hsl(var(--surface-2)/0.88)] backdrop-blur-xl`,
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
            <div className="absolute left-1/2 top-[var(--radius-2xl)] bottom-[var(--radius-2xl)] w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-200 group-hover:bg-primary/22" />
          </div>
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 bg-[hsl(var(--surface-2)/0.88)]">
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-2xl rounded-bl-2xl bg-[hsl(var(--background))]">
          {/* 分割线：直线段用 1px 实线保持锐利；两个圆角段用 1.5px 的 SVG 弧线
              补偿抗锯齿覆盖率损耗（斜线段每个像素只被覆盖约一半，需要更宽的墨量
              才能与直线段视觉等粗）。尺寸绑定 --radius-2xl，与圆角始终对齐。 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-[var(--radius-2xl)] bottom-[var(--radius-2xl)] z-30 w-px bg-[hsl(var(--layout-divider))]"
          />
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-30"
            style={{ width: 'var(--radius-2xl)', height: 'var(--radius-2xl)' }}
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M0.5 12 A11.5 11.5 0 0 1 12 0.5"
              stroke="hsl(var(--layout-divider))"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 z-30"
            style={{ width: 'var(--radius-2xl)', height: 'var(--radius-2xl)' }}
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M0.5 0 A11.5 11.5 0 0 0 12 11.5"
              stroke="hsl(var(--layout-divider))"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <TitleBar
            leftContent={sidebarCollapsed ? sidebarControls : undefined}
            rightContent={headerContent}
            projectOpenPath={projectOpenPath}
            sidePanelAvailable={sidePanelAvailable}
            todos={todos}
          />

          <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--background))]">
            <div className="flex min-w-110 flex-1 flex-col bg-[hsl(var(--background))]">{children}</div>
            <SidePanel
              projectPath={sidePanelProjectPath}
              scopeId={sidePanelScopeId}
              isVisible={sidePanelAvailable}
            />
          </main>
        </section>
      </div>
    </div>
  );
}
