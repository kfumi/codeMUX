import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import type { TerminalEvent } from '../../../lib/daemon-client/terminal';
import { useAppearanceStore } from '../../../stores/appearanceStore';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { useSettingsStore } from '../../../stores/settingsStore';

function terminalTheme() {
  const isDark = document.documentElement.classList.contains('dark');

  return isDark
    ? {
      background: '#111111',
      foreground: '#e5e7eb',
      cursor: '#f8fafc',
      selectionBackground: '#334155',
      black: '#0f172a',
      red: '#f87171',
      green: '#86efac',
      yellow: '#fde047',
      blue: '#93c5fd',
      magenta: '#d8b4fe',
      cyan: '#67e8f9',
      white: '#e5e7eb',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#bbf7d0',
      brightYellow: '#fef08a',
      brightBlue: '#bfdbfe',
      brightMagenta: '#e9d5ff',
      brightCyan: '#a5f3fc',
      brightWhite: '#ffffff',
    }
    : {
      background: '#ffffff',
      foreground: '#1f2937',
      cursor: '#475569',
      selectionBackground: '#d4d4d8',
    };
}

function isTerminalNotFoundError(error: unknown): boolean {
  return String(error).includes('Terminal session not found');
}

const pendingTerminalStarts = new Map<string, Promise<string>>();

function getOrStartTerminal(
  tabId: string,
  projectPath: string,
  cols: number,
  rows: number,
  onEvent: (event: TerminalEvent) => void,
): { promise: Promise<string>; reusedPendingStart: boolean } {
  const pending = pendingTerminalStarts.get(tabId);
  if (pending) {
    return { promise: pending, reusedPendingStart: true };
  }

  const promise = daemonFacade.terminal.start(projectPath, cols, rows, onEvent).then(
    (connectedTerminalId) => {
      if (pendingTerminalStarts.get(tabId) === promise) {
        pendingTerminalStarts.delete(tabId);
      }
      return connectedTerminalId;
    },
    (error) => {
      if (pendingTerminalStarts.get(tabId) === promise) {
        pendingTerminalStarts.delete(tabId);
      }
      throw error;
    },
  );
  pendingTerminalStarts.set(tabId, promise);
  return { promise, reusedPendingStart: false };
}

interface TerminalScrollbarMetrics {
  clientHeight: number;
  maxScroll: number;
  thumbHeight: number;
  thumbTop: number;
}

function TerminalScrollbar({
  viewport,
  isActive,
}: {
  viewport: HTMLElement | null;
  isActive: boolean;
}) {
  const [metrics, setMetrics] = useState<TerminalScrollbarMetrics | null>(null);
  const metricsRef = useRef<TerminalScrollbarMetrics | null>(null);

  useLayoutEffect(() => {
    if (!viewport || !isActive) {
      setMetrics(null);
      metricsRef.current = null;
      return;
    }

    const syncMetrics = () => {
      const clientHeight = viewport.clientHeight;
      const scrollHeight = Math.max(viewport.scrollHeight, clientHeight);
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      const thumbHeight = maxScroll > 0
        ? Math.max(28, (clientHeight * clientHeight) / scrollHeight)
        : clientHeight;
      const travel = Math.max(0, clientHeight - thumbHeight);
      const nextMetrics = {
        clientHeight,
        maxScroll,
        thumbHeight,
        thumbTop: maxScroll > 0 ? (viewport.scrollTop / maxScroll) * travel : 0,
      };

      metricsRef.current = nextMetrics;
      setMetrics(nextMetrics);
    };

    syncMetrics();
    viewport.addEventListener('scroll', syncMetrics, { passive: true });
    window.addEventListener('resize', syncMetrics);

    const mutationObserver = new MutationObserver(syncMetrics);
    mutationObserver.observe(viewport, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      viewport.removeEventListener('scroll', syncMetrics);
      window.removeEventListener('resize', syncMetrics);
      mutationObserver.disconnect();
    };
  }, [isActive, viewport]);

  if (!viewport || !isActive || !metrics || metrics.maxScroll <= 0) return null;

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const track = event.currentTarget.parentElement;
    const currentMetrics = metricsRef.current;
    if (!track || !currentMetrics) return;

    const trackRect = track.getBoundingClientRect();
    const maxTravel = Math.max(0, trackRect.height - currentMetrics.thumbHeight);
    if (maxTravel <= 0) return;

    const startY = event.clientY;
    const startScrollTop = viewport.scrollTop;
    const onMouseMove = (moveEvent: MouseEvent) => {
      viewport.scrollTop = startScrollTop
        + ((moveEvent.clientY - startY) / maxTravel) * currentMetrics.maxScroll;
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
    };

    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(viewport.clientHeight * 0.9, 1);
    if (event.key === 'ArrowDown') viewport.scrollTop += 40;
    else if (event.key === 'ArrowUp') viewport.scrollTop -= 40;
    else if (event.key === 'PageDown') viewport.scrollTop += page;
    else if (event.key === 'PageUp') viewport.scrollTop -= page;
    else if (event.key === 'Home') viewport.scrollTop = 0;
    else if (event.key === 'End') viewport.scrollTop = metrics.maxScroll;
    else return;
    event.preventDefault();
  };

  return (
    <div className="pointer-events-auto absolute inset-y-3 right-3 z-40 w-1.5 rounded-full">
      <div
        role="scrollbar"
        aria-label="终端滚动条"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={metrics.maxScroll}
        aria-valuenow={Math.round(viewport.scrollTop)}
        tabIndex={0}
        className="absolute left-0 right-0 cursor-grab rounded-full bg-muted-foreground/35 transition-colors hover:bg-muted-foreground/55 active:cursor-grabbing"
        style={{ height: `${metrics.thumbHeight}px`, top: `${metrics.thumbTop}px` }}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}

export function TerminalPanel({
  tabId,
  terminalId,
  projectPath,
  isActive = true,
}: {
  tabId: string;
  terminalId?: string;
  projectPath: string;
  isActive?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(terminalId ?? null);
  const connectedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const lastSynchronizedSizeRef = useRef<{ terminalId: string; cols: number; rows: number } | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const setTerminalId = useSidePanelStore((state) => state.setTerminalId);
  const theme = useSettingsStore((state) => state.config?.theme);
  const codeFontSize = useAppearanceStore((state) => state.prefs.codeFontSize);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !projectPath) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'Consolas, "JetBrains Mono", monospace',
      fontSize: codeFontSize,
      lineHeight: 1.35,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const viewport = container.querySelector<HTMLElement>('.xterm-viewport');
    setViewport(viewport);
    const stopScrollbarMousePropagation = (event: MouseEvent) => {
      if (!viewport) return;

      const rect = viewport.getBoundingClientRect();
      const scrollbarHitWidth = Math.max(16, viewport.offsetWidth - viewport.clientWidth);
      if (event.clientX >= rect.right - scrollbarHitWidth) {
        event.stopPropagation();
      }
    };
    viewport?.addEventListener('mousedown', stopScrollbarMousePropagation, true);

    let disposed = false;
    const handleEvent = (event: TerminalEvent) => {
      if (disposed) return;
      if (event.type === 'output' && event.data != null) {
        terminal.write(event.data);
      } else if (event.type === 'error') {
        setError(event.error ?? '终端错误');
      } else if (event.type === 'exit') {
        terminal.writeln('');
        terminal.writeln(`[进程已退出${event.code == null ? '' : `: ${event.code}`}]`);
      }
    };
    const reportError = (error: unknown) => {
      if (!disposed) setError(String(error));
    };
    const resizeConnectedTerminal = () => {
      if (!isActiveRef.current) return;

      fit.fit();
      const terminalId = terminalIdRef.current;
      if (connectedRef.current && terminalId) {
        const size = { terminalId, cols: terminal.cols, rows: terminal.rows };
        const lastSize = lastSynchronizedSizeRef.current;
        if (lastSize?.terminalId === size.terminalId && lastSize.cols === size.cols && lastSize.rows === size.rows) {
          return;
        }
        lastSynchronizedSizeRef.current = size;
        void daemonFacade.terminal.resize(size.terminalId, size.cols, size.rows).catch((error) => {
          if (lastSynchronizedSizeRef.current === size) {
            lastSynchronizedSizeRef.current = null;
          }
          reportError(error);
        });
      }
    };

    const disposeTerminalSession = (connectedTerminalId: string) => {
      const shouldClose = !useSidePanelStore.getState().isTabPresent(tabId);
      return shouldClose ? daemonFacade.terminal.close(connectedTerminalId) : Promise.resolve();
    };

    const connect = async () => {
      let connectedTerminalId = terminalIdRef.current;

      try {
        if (connectedTerminalId) {
          try {
            await daemonFacade.terminal.attach(connectedTerminalId, terminal.cols || 100, terminal.rows || 30, handleEvent);
          } catch (attachError) {
            if (!isTerminalNotFoundError(attachError) || disposed) {
              throw attachError;
            }
            connectedTerminalId = await daemonFacade.terminal.start(projectPath, terminal.cols || 100, terminal.rows || 30, handleEvent);
          }
        } else {
          const pendingStart = getOrStartTerminal(
            tabId,
            projectPath,
            terminal.cols || 100,
            terminal.rows || 30,
            handleEvent,
          );
          connectedTerminalId = await pendingStart.promise;
          if (pendingStart.reusedPendingStart) {
            if (disposed) {
              if (!useSidePanelStore.getState().isTabPresent(tabId)) {
                await daemonFacade.terminal.close(connectedTerminalId);
              }
              return;
            }
            await daemonFacade.terminal.attach(connectedTerminalId, terminal.cols || 100, terminal.rows || 30, handleEvent);
          }
        }

        terminalIdRef.current = connectedTerminalId;
        connectedRef.current = true;
        lastSynchronizedSizeRef.current = {
          terminalId: connectedTerminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        };
        setTerminalId(tabId, connectedTerminalId);
        resizeConnectedTerminal();

        if (disposed) {
          if (!useSidePanelStore.getState().isTabPresent(tabId)) {
            await daemonFacade.terminal.close(connectedTerminalId);
          }
        }
      } catch (err) {
        if (!disposed) setError(String(err));
      }
    };

    void connect();

    const dataDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (connectedRef.current && terminalId) void daemonFacade.terminal.write(terminalId, data).catch(reportError);
    });

    const resizeObserver = new ResizeObserver(resizeConnectedTerminal);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      dataDisposable.dispose();
      resizeObserver.disconnect();
      viewport?.removeEventListener('mousedown', stopScrollbarMousePropagation, true);
      setViewport(null);
      connectedRef.current = false;
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        void disposeTerminalSession(terminalId).catch((error) => {
          console.error('Terminal session cleanup failed', error);
        });
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
      lastSynchronizedSizeRef.current = null;
    };
  }, [codeFontSize, projectPath, setTerminalId, tabId]);

  useLayoutEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  return (
    <div className="terminal-panel relative h-full min-h-0 min-w-0 bg-white dark:bg-[#111111]">
      <div ref={containerRef} className="terminal-panel-container h-full min-h-0 min-w-0 w-full overflow-hidden p-3" />
      <TerminalScrollbar viewport={viewport} isActive={isActive} />
      {error && (
        <div className="absolute inset-x-4 top-4 rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-sm text-destructive shadow-sm">
          {error}
        </div>
      )}
    </div>
  );
}
