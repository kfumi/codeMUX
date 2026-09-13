import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState, useCallback, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { readLayoutPreferences, updateLayoutPreferences } from '../../lib/layoutPreferences';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useWindowMaximized } from '../../hooks/useWindowMaximized';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useShellLayoutStore } from '../../stores/shellLayoutStore';
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
  // 窄屏(工单 03):侧栏改为抽屉式覆盖层。响应式是布局问题,不是代码分叉 ——
  // 内容树完全复用,只有导航形态与尺寸不同。
  const isNarrow = useIsNarrowViewport();
  const narrowSidebarOpen = useShellLayoutStore((state) => state.narrowSidebarOpen);
  const setNarrowSidebarOpen = useShellLayoutStore((state) => state.setNarrowSidebarOpen);
  const navigationLocation = useNavigationStore((state) => state.current);
  const sidebarDragging = useRef(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarExistsRef = useRef(false);
  const sidebarInstant = sidebar != null && !sidebarExistsRef.current;

  useLayoutEffect(() => {
    sidebarExistsRef.current = sidebar != null;
  }, [sidebar != null]);

  // 抽屉里的导航动作(选会话/设置/自动化)发生后自动收起,避免遮住刚打开的
  // 内容。放在布局层订阅导航状态,任何来源的导航都遵守同一规则。
  useEffect(() => {
    if (isNarrow) {
      setNarrowSidebarOpen(false);
    }
  }, [isNarrow, navigationLocation, setNarrowSidebarOpen]);

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
    if (isNarrow) {
      useShellLayoutStore.getState().toggleNarrowSidebar();
      return;
    }
    setSidebarCollapsed((value) => !value);
  }, [isNarrow]);

  // 侧栏是否可见:桌面看收起状态,窄屏看抽屉开关。
  const sidebarVisible = isNarrow ? narrowSidebarOpen : !sidebarCollapsed;
  // 控制条(收起/后退/前进)的落点:桌面收起到标题栏,窄屏关抽屉时落标题栏、
  // 开抽屉时落抽屉内部。
  const controlsInTitleBar = isNarrow ? !narrowSidebarOpen : sidebarCollapsed;
  const hostForm = useDaemonConnectionStore((state) => state.hostForm);
  const windowMaximized = useWindowMaximized();
  // 圆角缺口(主面板左上/左下圆角 + 弧线分割线)是**窗口化桌面壳**专属的装饰:
  // 靠这两个圆角把紧邻的侧栏表面露出来当缺口。窗口最大化、浏览器与手机形态,
  // 以及侧栏收起/窄屏抽屉时,面板左缘就是窗口或视口边缘,圆角只会剩一条没来由
  // 的缺角,所以这些情况一律直线到底。
  const sidebarDocked = sidebar != null && sidebarVisible && !isNarrow;
  const showsCornerNotch = sidebarDocked && hostForm === 'desktop' && !windowMaximized;

  const sidebarToggleButton = sidebar != null ? (
    <TooltipHint content={sidebarVisible ? '收起侧栏' : '展开侧栏'}>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarVisible ? '收起侧栏' : '展开侧栏'}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45',
        )}
      >
        <RoundedPanelIcon side="left" expanded={sidebarVisible} className="h-4 w-4" />
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
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/35 disabled:hover:bg-transparent"
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
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/35 disabled:hover:bg-transparent"
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
    <div className={cn('app-shell flex bg-background text-foreground', isNarrow ? 'h-[100dvh]' : 'h-screen')}>
      {/* 桌面:侧栏展开时把控制条浮在侧栏左上角(CSS 固定定位,与侧栏同层)。 */}
      {sidebar != null && sidebarVisible && !isNarrow && (
        <div className="fixed left-2 top-2 z-40">
          {sidebarControls}
        </div>
      )}

      {/* 窄屏:抽屉打开时页面上盖一层遮罩,点它收起抽屉(触屏的常见手势)。 */}
      {sidebar != null && isNarrow && narrowSidebarOpen && (
        <div
          aria-hidden="true"
          onClick={() => setNarrowSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-[hsl(var(--surface-shadow-strong)/0.42)] backdrop-blur-[1px]"
        />
      )}

      {sidebar != null && (
        <aside
          className={cn(
            'overflow-hidden bg-[hsl(var(--surface-2)/0.88)] backdrop-blur-xl',
            isNarrow
              // 抽屉是触屏界面:按钮统一到 44px 最小触控高度(HIG/Material 标准)。
              ? 'fixed inset-y-0 left-0 z-50 w-[86vw] max-w-80 shadow-[18px_0_44px_-30px_hsl(var(--surface-shadow-strong)/0.6)] [&_button]:min-h-11'
              : 'relative shrink-0',
            sidebarResizing ? 'transition-none' : 'transition-[width,opacity,transform] duration-300 ease-in-out',
          )}
          style={isNarrow
            ? {
                transform: narrowSidebarOpen ? 'translateX(0)' : 'translateX(-101%)',
                opacity: narrowSidebarOpen ? 1 : 0,
                visibility: narrowSidebarOpen ? 'visible' : 'hidden',
              }
            : {
                width: sidebarCollapsed ? 0 : sidebarWidth,
                opacity: sidebarCollapsed ? 0 : 1,
                transitionDuration: sidebarInstant ? '0ms' : undefined,
              }}
          aria-hidden={isNarrow ? !narrowSidebarOpen : sidebarCollapsed}
        >
          <div
            className="relative z-10 flex h-full flex-col"
            style={isNarrow ? undefined : { width: sidebarWidth }}
          >
            {/* 窄屏:抽屉盖住了标题栏,收起按钮必须放在抽屉内部才点得到。
                Sidebar 自身的顶部留白(pt-11)正好让出这一条控制区。 */}
            {isNarrow && (
              <div className="absolute left-2 top-2 z-40">
                {sidebarControls}
              </div>
            )}
            {sidebar}
          </div>
          {/* 窄屏不做拖拽改宽:抽屉宽度由视口决定。 */}
          {!isNarrow && (
            <div
              className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
              onMouseDown={handleSidebarMouseDown}
            >
              <div className="absolute left-1/2 top-[var(--radius-2xl)] bottom-[var(--radius-2xl)] w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-200 group-hover:bg-primary/22" />
            </div>
          )}
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 bg-[hsl(var(--surface-2)/0.88)]">
        <section
          className={cn(
            'relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--background))]',
            showsCornerNotch && 'rounded-tl-2xl rounded-bl-2xl',
          )}
        >
          {/* 分割线：直线段用 1px 实线保持锐利；圆角形态下两个圆角段用 1.5px 的
              SVG 弧线补偿抗锯齿覆盖率损耗（斜线段每个像素只被覆盖约一半，需要更
              宽的墨量才能与直线段视觉等粗）。尺寸绑定 --radius-2xl，与圆角对齐。
              侧栏没有停靠（收起/抽屉）时面板左缘就是窗口边缘，不画任何分割线。 */}
          {sidebarDocked && (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute left-0 z-30 w-px bg-[hsl(var(--layout-divider))]',
                showsCornerNotch
                  ? 'top-[var(--radius-2xl)] bottom-[var(--radius-2xl)]'
                  : 'inset-y-0',
              )}
            />
          )}
          {showsCornerNotch && (
            <>
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
            </>
          )}
          <TitleBar
            leftContent={controlsInTitleBar ? sidebarControls : undefined}
            rightContent={headerContent}
            projectOpenPath={projectOpenPath}
            sidePanelAvailable={sidePanelAvailable}
            todos={todos}
          />

          <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--background))]">
            {/* 窄屏下聊天列不再要求最小宽度,否则 420px 视口里会被挤出横向滚动。 */}
            <div className={cn('flex flex-1 flex-col bg-[hsl(var(--background))]', isNarrow ? 'min-w-0' : 'min-w-110')}>
              {children}
            </div>
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
