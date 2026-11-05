import { ChevronDown, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { ErrorBoundary } from '../../ErrorBoundary';
import { getSessionSnapshot, terminalRegistry, subscribeSession } from '../../../lib/terminal/sessionRegistry';
import { terminalShellLabel } from '../../../lib/terminal/terminalShellLabel';
import { updateLayoutPreferences } from '../../../lib/layoutPreferences';
import { cn } from '../../../lib/utils';
import {
  TERMINAL_DOCK_MAX_RATIO,
  TERMINAL_DOCK_MIN_HEIGHT,
  clampTerminalDockHeight,
  useTerminalDockStore,
} from '../../../stores/terminalDockStore';
import { ResizeOverlay } from '../../ui/resize-overlay';
import { TooltipHint } from '../../ui/tooltip';
import { TerminalView } from './TerminalView';

/**
 * 对话列下方的终端面板。
 *
 * 结构对齐 ZCode：头部（折叠 / 标题 / 标签条 / 新建 / 关闭）+ 常驻挂载的标签内容 +
 * 顶部拖拽条。面板收起时高度归零但**不卸载**标签，终端与 PTY 继续存活；开合是高度
 * 过渡，不是挂载/卸载，所以展开时不会出现重绘。
 *
 * 终端本身由 `terminalRegistry` 持有（见 ADR 0022），这里只负责 surface 的布局与交互。
 */
export function TerminalDock({ projectPath }: { projectPath: string }) {
  const dockRef = useRef<HTMLDivElement>(null);
  const isOpen = useTerminalDockStore((state) => state.isOpen);
  const heightPx = useTerminalDockStore((state) => state.heightPx);
  const isResizing = useTerminalDockStore((state) => state.isResizing);
  const workspace = useTerminalDockStore((state) => state.workspaces[projectPath]);
  const sessions = useTerminalDockStore((state) => state.sessions);
  const open = useTerminalDockStore((state) => state.open);
  const close = useTerminalDockStore((state) => state.close);
  const newTerminal = useTerminalDockStore((state) => state.newTerminal);
  const closeTerminal = useTerminalDockStore((state) => state.closeTerminal);
  const setActiveSession = useTerminalDockStore((state) => state.setActiveSession);
  const setHeight = useTerminalDockStore((state) => state.setHeight);
  const setResizing = useTerminalDockStore((state) => state.setResizing);

  const tabs = (workspace?.sessionIds ?? [])
    .map((id) => sessions[id])
    .filter((session): session is NonNullable<typeof session> => Boolean(session));
  const activeSessionId = workspace?.activeSessionId ?? null;

  // 头部显示当前终端的 shell 标签；快照由 registry 推过来，不额外存一份状态。
  const activeKey = isOpen ? activeSessionId : null;
  const subscribeActive = useCallback(
    (listener: () => void) => (activeKey ? subscribeSession(activeKey, listener) : () => {}),
    [activeKey],
  );
  const readActive = useCallback(
    () => (activeKey ? getSessionSnapshot(activeKey) : null),
    [activeKey],
  );
  const activeSnapshot = useSyncExternalStore(subscribeActive, readActive, readActive);
  const shellLabel = terminalShellLabel(activeSnapshot?.shell);

  // 打开着的 dock 必须至少有一个标签；首次打开（或项目刚切换）时惰性创建。
  useEffect(() => {
    if (isOpen) open(projectPath);
  }, [isOpen, open, projectPath]);

  const maxHeight = useCallback(() => {
    const available = dockRef.current?.parentElement?.clientHeight ?? 0;
    // 父容器还没布局（首帧、测试环境）时不做上限 —— 用 0 会把高度误夹到最小值。
    if (available <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(TERMINAL_DOCK_MIN_HEIGHT, available * TERMINAL_DOCK_MAX_RATIO);
  }, []);

  // 窗口变矮时把高度夹回「不超过对话列一半」，否则聊天区会被挤没。
  useEffect(() => {
    const clampToViewport = () => {
      const current = useTerminalDockStore.getState().heightPx;
      const clamped = clampTerminalDockHeight(current, maxHeight());
      if (clamped !== current) setHeight(clamped, maxHeight());
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [maxHeight, setHeight]);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = useTerminalDockStore.getState().heightPx;

    setResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.documentElement.classList.add('cmx-panel-resizing');

    const onMove = (moveEvent: MouseEvent) => {
      setHeight(startHeight + (startY - moveEvent.clientY), maxHeight());
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.documentElement.classList.remove('cmx-panel-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      updateLayoutPreferences({ terminalDockHeight: useTerminalDockStore.getState().heightPx });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }, [maxHeight, setHeight, setResizing]);

  const handleCloseTerminal = useCallback((sessionId: string) => {
    // 关标签是唯一销毁终端的路径；最后一个标签关掉时 dock 由 store 收起。
    terminalRegistry.release(sessionId);
    closeTerminal(sessionId);
  }, [closeTerminal]);

  return (
    <div
      ref={dockRef}
      data-terminal-dock={isOpen ? 'open' : 'closed'}
      aria-hidden={!isOpen}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-t border-border bg-[hsl(var(--background))]',
        isResizing ? 'transition-none' : 'transition-[height] duration-normal ease-motion-in-out',
      )}
      style={{ height: isOpen ? heightPx : 0 }}
    >
      {isOpen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整终端高度"
          data-testid="terminal-dock-resize-handle"
          className="group absolute inset-x-0 top-0 z-30 h-1.5 cursor-row-resize"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute inset-x-0 top-0 h-px bg-transparent transition-colors duration-fast group-hover:bg-primary/35 group-active:bg-primary/45" />
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1">
        <TooltipHint content="收起终端">
          <button
            type="button"
            aria-label="收起终端"
            onClick={close}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </TooltipHint>

        <span className="shrink-0 pr-1 text-ui-meta text-muted-foreground">
          终端
          {shellLabel ? ` · ${shellLabel}` : ''}
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.id === activeSessionId;
            return (
              <div
                key={tab.id}
                className={cn(
                  'group flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors duration-fast',
                  active
                    ? 'border-border bg-[hsl(var(--surface-1))] text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-foreground/6 hover:text-foreground',
                )}
              >
                <button
                  type="button"
                  data-testid="terminal-dock-tab"
                  data-active={active ? 'true' : 'false'}
                  onClick={() => setActiveSession(tab.id)}
                  className="min-w-0 truncate text-left"
                  title={tab.title}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => handleCloseTerminal(tab.id)}
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-2xs text-muted-foreground transition-opacity duration-fast hover:bg-foreground/10 hover:text-foreground',
                    active ? 'opacity-70' : 'opacity-0 group-focus-within:opacity-70 group-hover:opacity-70',
                  )}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        <TooltipHint content="新建终端">
          <button
            type="button"
            aria-label="新建终端"
            onClick={() => newTerminal(projectPath)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </TooltipHint>

        <TooltipHint content="关闭终端面板">
          <button
            type="button"
            aria-label="关闭终端面板"
            onClick={close}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </TooltipHint>
      </div>

      <div className="relative min-h-0 flex-1">
        <ErrorBoundary
          fallback={(
            <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
              终端渲染失败，关闭面板后可重新打开
            </div>
          )}
        >
          {tabs.map((tab) => {
            const active = isOpen && tab.id === activeSessionId;
            return (
              <div
                key={tab.id}
                className={cn(
                  'absolute inset-0',
                  active ? 'visible z-10 pointer-events-auto' : 'invisible z-0 pointer-events-none',
                )}
                aria-hidden={!active}
              >
                <TerminalView
                  sessionKey={tab.id}
                  projectPath={tab.projectPath}
                  isActive={active}
                />
              </div>
            );
          })}
        </ErrorBoundary>
      </div>

      <ResizeOverlay active={isResizing} cursor="row-resize" />
    </div>
  );
}
