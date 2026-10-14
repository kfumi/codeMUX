import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState, useCallback, useLayoutEffect, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { readLayoutPreferences, updateLayoutPreferences } from '../../lib/layoutPreferences';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useWindowMaximized } from '../../hooks/useWindowMaximized';
import { useShortcutAriaKeyshortcuts, useShortcutHint } from '../../hooks/useShortcutHint';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useShellLayoutStore } from '../../stores/shellLayoutStore';
import type { TodoItem } from '../../types/agent';
import { SidePanel } from '../workspace/SidePanel';
import { TooltipHint } from '../ui/tooltip';
import { NavRail, type NavRailTarget } from './NavRail';
import { RoundedPanelIcon } from './RoundedPanelIcon';
import { TitleBar, type TitleBarNavigation } from './TitleBar';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 300;

/** 自绘标题栏高度 —— 抽屉/遮罩要落在它下面，控件才不会被盖住。 */
const TITLE_BAR_HEIGHT_CLASS = 'top-12';

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
  /** 导航栏当前高亮项与切换回调（缺省时不渲染导航栏）。 */
  navRailTarget?: NavRailTarget;
  onNavRailSelect?: (target: NavRailTarget) => void;
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
  navRailTarget,
  onNavRailSelect,
}: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  // 侧栏收起状态落在布局 store：它是可绑定命令（折叠/展开侧边栏），
  // 分发器只认 store，不该去猜组件的局部状态。
  const sidebarCollapsed = useShellLayoutStore((state) => state.sidebarCollapsed);
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
    // 同一个动作既给按钮也给「折叠/展开侧边栏」命令用，逻辑只此一处
    useShellLayoutStore.getState().toggleSidebar(isNarrow);
  }, [isNarrow]);

  // tooltip 里带出当前键位（用户改键后提示跟着变）
  const sidebarToggleHint = useShortcutHint('toggleSidebar');
  const backHint = useShortcutHint('navigateBack');
  const forwardHint = useShortcutHint('navigateForward');
  const sidebarToggleAria = useShortcutAriaKeyshortcuts('toggleSidebar');
  const backAria = useShortcutAriaKeyshortcuts('navigateBack');
  const forwardAria = useShortcutAriaKeyshortcuts('navigateForward');

  // 侧栏是否可见:桌面看收起状态,窄屏看抽屉开关。
  const sidebarVisible = isNarrow ? narrowSidebarOpen : !sidebarCollapsed;
  const hostForm = useDaemonConnectionStore((state) => state.hostForm);
  const windowMaximized = useWindowMaximized();
  // 内容面的圆角裁切与页面浮层:主聊天区从窗口边缘「浮起来」。窗口最大化、
  // 浏览器与手机形态时,内容面贴满视口,圆角只会剩一条没来由的缺角,所以直线到底。
  const sidebarDocked = sidebar != null && sidebarVisible && !isNarrow;
  const contentFloats = sidebarDocked && hostForm === 'desktop' && !windowMaximized;

  const sidebarToggleButton = sidebar != null ? (
    <TooltipHint content={sidebarVisible ? `收起侧栏${sidebarToggleHint ? ` · ${sidebarToggleHint}` : ''}` : `展开侧栏${sidebarToggleHint ? ` · ${sidebarToggleHint}` : ''}`}>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarVisible ? '收起侧栏' : '展开侧栏'}
        aria-keyshortcuts={sidebarToggleAria ?? undefined}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-fast hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45',
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
          <TooltipHint content={`后退${backHint ? ` · ${backHint}` : ''}`}>
            <button
              type="button"
              aria-label="后退"
              aria-keyshortcuts={backAria ?? undefined}
              disabled={!titleBarNavigation.canGoBack}
              onClick={titleBarNavigation.onBack}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground transition-colors duration-fast hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/35 disabled:hover:bg-transparent"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </TooltipHint>
          <TooltipHint content={`前进${forwardHint ? ` · ${forwardHint}` : ''}`}>
            <button
              type="button"
              aria-label="前进"
              aria-keyshortcuts={forwardAria ?? undefined}
              disabled={!titleBarNavigation.canGoForward}
              onClick={titleBarNavigation.onForward}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground transition-colors duration-fast hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:text-foreground/35 disabled:hover:bg-transparent"
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
    <div
      className={cn(
        'app-shell flex flex-col bg-background text-foreground',
        isNarrow ? 'h-[100dvh]' : 'h-screen',
      )}
    >
      {/*
       * 标题栏跨全宽，位于导航栏与侧栏之上 —— 与 Codex 的原生 caption 同构。
       * 控件（收起/后退/前进/会话头/主题切换）因此永远落在这一条里，
       * 不再需要「侧栏展开时浮在侧栏左上角」的那套定位。
       */}
      <TitleBar
        leftContent={sidebarControls}
        rightContent={headerContent}
        projectOpenPath={projectOpenPath}
        sidePanelAvailable={sidePanelAvailable}
        todos={todos}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* 窄屏:抽屉打开时页面上盖一层遮罩,点它收起抽屉(触屏的常见手势)。
            遮罩从标题栏下方开始,标题栏控件保持可点。 */}
        {sidebar != null && isNarrow && narrowSidebarOpen && (
          <div
            aria-hidden="true"
            onClick={() => setNarrowSidebarOpen(false)}
            className={cn('fixed inset-x-0 bottom-0 z-40 bg-[hsl(var(--surface-shadow-strong)/0.42)] backdrop-blur-[1px]', TITLE_BAR_HEIGHT_CLASS)}
          />
        )}

        {sidebar != null && navRailTarget && onNavRailSelect && (
          <NavRail activeTarget={navRailTarget} onSelect={onNavRailSelect} />
        )}

        {sidebar != null && (
          <aside
            className={cn(
              // 这块常驻侧栏刻意不用 backdrop-blur：桌面形态下它背后只有 .app-shell / body 的平整
              // 纯色，blur 对纯色是恒等变换；而它面积大、桌面形态下常驻，整屏模糊
              // 只有开销没有观感收益。窄屏抽屉复用同一 className，靠 88% 不透明底色已足够可读。
              // 不变量见 MainLayout.test.tsx（含源码级契约）。
              // 侧栏与导航栏共用**窗口表面**（Codex 的 rail 与 sidebar 同色，
              // 只有内容面浮起来）；选中态由 `--sidebar-muted` 承担。
              'overflow-hidden bg-[hsl(var(--sidebar-bg))]',
              isNarrow
                // 抽屉宽度跟随视口但稍宽于桌面侧栏默认值；顶部让出标题栏那条，
                // 底部的收起按钮因此留在标题栏里，不用在抽屉里复制一份。
                ? cn('fixed bottom-0 left-0 z-50 w-[92vw] max-w-96 shadow-[18px_0_44px_-30px_hsl(var(--surface-shadow-strong)/0.6)]', TITLE_BAR_HEIGHT_CLASS)
                : 'relative shrink-0 border-r border-[hsl(var(--layout-divider))]',
              sidebarResizing ? 'transition-none' : 'transition-[width,opacity,transform] duration-slow ease-motion-in-out',
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
              {sidebar}
            </div>
            {/* 窄屏不做拖拽改宽:抽屉宽度由视口决定。 */}
            {!isNarrow && (
              <div
                className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
                onMouseDown={handleSidebarMouseDown}
              >
                <div className="absolute left-1/2 top-[var(--radius-content)] bottom-[var(--radius-content)] w-px -translate-x-1/2 rounded-full bg-transparent transition-all duration-normal group-hover:bg-primary/22" />
              </div>
            )}
          </aside>
        )}

        {/*
          外层容器的底色是 **窗口表面**（Codex 的 `--surface`：导航栏、侧栏、
          内容面之间的「空气」都是它），内容面本身才是浮在上面那块更亮的面 ——
          浅色下面板比窗口亮、深色下亮一点。把这两层摆反的话，浮起的观感会完全
          消失（浅色下面板比窗口暗，等于一个洞）。
        */}
        <div className="relative flex min-w-0 flex-1 bg-[hsl(var(--background))]">
          <section
            data-content-surface
            data-floats={String(contentFloats)}
            className="content-surface-root relative flex min-w-0 flex-1 flex-col bg-[hsl(var(--surface-1))] shadow-elevation-content"
          >
            <div className="content-surface flex min-h-0 flex-1 flex-col overflow-hidden">
              <main className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--surface-1))]">
                {/* 窄屏下聊天列不再要求最小宽度,否则 420px 视口里会被挤出横向滚动。 */}
                <div className={cn('flex flex-1 flex-col bg-[hsl(var(--surface-1))]', isNarrow ? 'min-w-0' : 'min-w-110')}>
                  {children}
                </div>
                <SidePanel
                  projectPath={sidePanelProjectPath}
                  scopeId={sidePanelScopeId}
                  isVisible={sidePanelAvailable}
                />
              </main>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
