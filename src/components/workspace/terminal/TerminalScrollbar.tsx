import { useLayoutEffect, useRef, useState } from 'react';

interface TerminalScrollbarMetrics {
  clientHeight: number;
  maxScroll: number;
  thumbHeight: number;
  thumbTop: number;
}

/**
 * 终端右侧的细滚动条。
 *
 * xterm 自己的 viewport 滚动条被 CSS 隐藏了（见 globals.css），这里按 viewport 的
 * `scrollTop/scrollHeight` 画一根同样语义的轨道。它只在**当前活动的终端**上挂载 ——
 * 后台标签隐藏时不监听 DOM 变化，省掉一个 MutationObserver 每帧跑。
 */
export function TerminalScrollbar({
  viewport,
  isActive,
}: {
  viewport: HTMLElement | null;
  isActive: boolean;
}) {
  const [metrics, setMetrics] = useState<TerminalScrollbarMetrics | null>(null);
  const metricsRef = useRef<TerminalScrollbarMetrics | null>(null);

  /**
   * xterm 在 viewport 上监听 mousedown 用于选中文本；滚动条的按下如果冒泡过去，
   * 拖拽就会被当成选区。在捕获阶段拦住靠右这条命中区。
   */
  useLayoutEffect(() => {
    if (!viewport) return;
    const stopScrollbarMousePropagation = (event: MouseEvent) => {
      const rect = viewport.getBoundingClientRect();
      const scrollbarHitWidth = Math.max(16, viewport.offsetWidth - viewport.clientWidth);
      if (event.clientX >= rect.right - scrollbarHitWidth) {
        event.stopPropagation();
      }
    };

    viewport.addEventListener('mousedown', stopScrollbarMousePropagation, true);
    return () => viewport.removeEventListener('mousedown', stopScrollbarMousePropagation, true);
  }, [viewport]);

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
