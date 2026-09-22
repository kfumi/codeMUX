import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { daemonFacade } from '../../../lib/facades/daemon-facade';
import type { TerminalEvent } from '../../../lib/daemon-client/terminal';
import { useAppearanceStore } from '../../../stores/appearanceStore';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { useSettingsStore } from '../../../stores/settingsStore';

/**
 * 终端标签在后台时的输出缓冲上限（字符数）。
 *
 * 超限后丢弃**最早**的输出并留下提示——这与 xterm 自己的 scrollback 在超限时丢弃最早行的
 * 语义一致，丢掉的也是已经滚出视野的内容。
 */
const INACTIVE_OUTPUT_MAX_CHARS = 128 * 1024;

/** 缓冲区发生过截断时插在最前面的提示，让用户知道上面的内容不完整。 */
const INACTIVE_OUTPUT_DROP_NOTICE = '\r\n[隐藏期间的早期输出已省略]\r\n';

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
  /** 标签不在前台时收到的输出先攒在这里，切回前台的那一帧一次性写入 xterm（见文件末尾的 layout effect）。 */
  const pendingOutputRef = useRef('');
  /** 尺寸同步回调由 terminal 创建时登记；切回前台要主动跑一次（见文件末尾的 layout effect）。 */
  const resizeHandlerRef = useRef<(() => void) | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const setTerminalId = useSidePanelStore((state) => state.setTerminalId);
  const theme = useSettingsStore((state) => state.config?.theme);
  const codeFontSize = useAppearanceStore((state) => state.prefs.codeFontSize);

  /** 初始字号只在创建 xterm 时读一次；之后一律走"只改视图选项"的路径（见上面的字号 effect）。 */
  const codeFontSizeRef = useRef(codeFontSize);
  codeFontSizeRef.current = codeFontSize;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  /**
   * 字号是**纯视图选项**：只改 `options.fontSize` 再重算尺寸即可。
   *
   * 它原来挂在下面那个"创建 xterm + attach"的 effect 的依赖里，于是用户每改一次代码字号就会
   * 重建 xterm 并重新 attach —— 而那等于**换一条 PTY**：上一轮缓冲丢失、daemon 侧多留一条会话。
   * 后台标签不在这里 fit：`resizeConnectedTerminal` 自己会按 `isActiveRef` 提前返回，
   * 等标签被激活时由激活路径补一次尺寸同步。
   */
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.options.fontSize === codeFontSize) return;
    terminal.options.fontSize = codeFontSize;
    resizeHandlerRef.current?.();
  }, [codeFontSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !projectPath) return;

    // 这段 effect 会新建 xterm 并走一次 attach/start，也就是**换了一条 PTY**：上一轮攒下的
    // 缓冲属于旧会话，不能回放到新终端上（否则屏幕上会出现"新 shell banner + 旧会话尾部"）。
    pendingOutputRef.current = '';

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'Consolas, "JetBrains Mono", monospace',
      fontSize: codeFontSizeRef.current,
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

    /**
     * 后台标签的终端**不解析**输出。
     *
     * `SidePanel` 让所有终端标签常驻挂载，只靠 `invisible` 隐藏（`SidePanel.tsx:304-323`），
     * 而 xterm 的 `write` 是同步解析的：一个在后台跑着 dev server 的标签会持续占用主线程
     * 解析输出、推进 scrollback，即使根本没人看得见它。所以标签不在前台时只把输出攒起来，
     * 切回前台的那一帧再一次性写入。
     */
    const writeOutput = (text: string) => {
      if (isActiveRef.current) {
        terminal.write(text);
        return;
      }

      const next = pendingOutputRef.current + text;
      if (next.length <= INACTIVE_OUTPUT_MAX_CHARS) {
        pendingOutputRef.current = next;
        return;
      }

      // 超限时保留尾部，并且**从行界之后**开始：直接按字符切会把一条 ANSI 转义序列切成两半，
      // 终端就会把半截转义码当普通文本渲染出来。CR 也算行界——进度条那种用 `\r` 覆盖同一行
      // 的输出没有 `\n`，只找 `\n` 会退化成按字符切，等于没修。
      const overflowStart = next.length - INACTIVE_OUTPUT_MAX_CHARS;
      const breakOffset = next.slice(overflowStart).search(/[\r\n]/);
      pendingOutputRef.current = breakOffset === -1
        // 整个尾部都没有行界（一条超长单行，例如无换行的 JSON/base64 转储）：此时任何字符级
        // 截断都可能切坏内容，宁可只留省略提示——这是唯一不会吐出半截转义码的选择。
        ? INACTIVE_OUTPUT_DROP_NOTICE
        : INACTIVE_OUTPUT_DROP_NOTICE + next.slice(overflowStart + breakOffset + 1);
    };

    const handleEvent = (event: TerminalEvent) => {
      if (disposed) return;
      if (event.type === 'output' && event.data != null) {
        writeOutput(event.data);
      } else if (event.type === 'error') {
        setError(event.error ?? '终端错误');
      } else if (event.type === 'exit') {
        writeOutput(`\r\n[进程已退出${event.code == null ? '' : `: ${event.code}`}]\r\n`);
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

    resizeHandlerRef.current = resizeConnectedTerminal;

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
  }, [projectPath, setTerminalId, tabId]);

  useLayoutEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive) return;

    // 切回前台：把后台期间攒下的输出一次性交给 xterm。用 layout effect 是为了赶在这一帧
    // 绘制之前写入，避免先闪一下旧内容再补上。终端不存在（正在重建）时保留缓冲，别丢。
    const terminal = terminalRef.current;
    const pending = pendingOutputRef.current;
    if (terminal && pending) {
      pendingOutputRef.current = '';
      terminal.write(pending);
    }

    // 标签在后台时容器尺寸可能已经变过：`resizeConnectedTerminal` 在非前台时直接 return，
    // 而 ResizeObserver 只在尺寸变化那一刻回调一次，切回来就不会再补——不补跑这一下，
    // 该标签会一直用旧的 cols/rows 显示。首次挂载时它还是 null（layout effect 早于创建 effect）。
    resizeHandlerRef.current?.();
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
