import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * 折叠动画期间钉住最近可滚动祖先的 scrollTop，防止高度动画引起滚动跳变。
 *
 * 刻意不复刻 @assistant-ui/react 的 `useScrollLock` 的"隐藏滚动条 + padding 补偿"：
 * 该实现会给滚动容器写内联 `scrollbar-width: none` 并把 `padding-right` 加上滚动条宽度，
 * 200ms 后恢复为各自捕获的旧值。思考（reasoning.tsx）/ 工具组（tool-group.tsx）/
 * 工具（tool-fallback.tsx）三个组件各自实例化它，却共享同一个线程滚动容器
 * （CodeMuxThread 视口，`overflow-y-scroll scrollbar-gutter-stable`，经典滚动条 10px）。
 * 当两个锁的 200ms 窗口重叠时，后锁捕获的 `previousPadding` 是前锁写入的补偿值，
 * 前锁先到期恢复为空、后锁后到期把补偿值写回 —— padding-right 永久残留并随每次重叠
 * 累积 +10px，表现为"反复展开收起后内容区越来越窄、离右边越来越远"。
 *
 * 本视口滚动条与 gutter 本就常驻（overflow-y-scroll + scrollbar-gutter: stable），
 * 动画期间根本不需要隐藏滚动条，也就无需任何宽度补偿；只保留钉滚动位置这一有效部分。
 */
export function useCollapsibleScrollLock<T extends HTMLElement = HTMLElement>(
  animatedElementRef: RefObject<T | null>,
  animationDuration: number,
) {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const lockScroll = useCallback(() => {
    cleanupRef.current?.();

    if (!scrollContainerRef.current && animatedElementRef.current) {
      let element: HTMLElement | null = animatedElementRef.current;
      while (element) {
        const { overflowY } = getComputedStyle(element);
        if (overflowY === 'scroll' || overflowY === 'auto') {
          scrollContainerRef.current = element;
          break;
        }
        element = element.parentElement;
      }
    }

    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const scrollPosition = scrollContainer.scrollTop;
    const resetPosition = () => {
      scrollContainer.scrollTop = scrollPosition;
    };
    scrollContainer.addEventListener('scroll', resetPosition);

    const timeoutId = setTimeout(() => {
      scrollContainer.removeEventListener('scroll', resetPosition);
      cleanupRef.current = null;
    }, animationDuration);

    cleanupRef.current = () => {
      clearTimeout(timeoutId);
      scrollContainer.removeEventListener('scroll', resetPosition);
    };
  }, [animationDuration, animatedElementRef]);

  return lockScroll;
}
