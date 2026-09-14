import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export function isTranscriptViewportAtBottom(viewport: HTMLDivElement): boolean {
  return viewport.scrollHeight <= viewport.clientHeight
    || Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
}

export function useTranscriptFollowLatest({
  viewportRef,
  followKey,
  extraFrames = 1,
  forceFollow = false,
  behavior = 'auto',
}: {
  viewportRef: RefObject<HTMLDivElement>;
  followKey: unknown;
  extraFrames?: number;
  forceFollow?: boolean;
  behavior?: ScrollBehavior;
}) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const followLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const atBottom = isTranscriptViewportAtBottom(viewport);
    if (atBottom) {
      followLatestRef.current = true;
    } else if (
      viewport.scrollTop < lastScrollTopRef.current
      && viewport.scrollHeight === lastScrollHeightRef.current
    ) {
      followLatestRef.current = false;
    }

    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    setIsAtBottom(atBottom);
  }, [viewportRef]);

  const scrollViewportToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const nextScrollHeight = viewport.scrollHeight;
    viewport.scrollTop = nextScrollHeight;
    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = nextScrollHeight;
    setIsAtBottom(true);
  }, [viewportRef]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    updateScrollState();
    viewport.addEventListener('scroll', updateScrollState, { passive: true });

    // 只按 followKey 抢帧滚动会漏掉"高度变了但 key 没变"的增长：消息树由
    // assistant-ui 在父级 effect 里二次提交（useExternalStoreRuntime 的
    // setAdapter），此时读到的是旧 scrollHeight；折叠动画、图片解码、代码块
    // 升级和工具静默期同理。改为等内容真正变化后再钉底。
    const lastObserved = { scrollHeight: -1, clientHeight: -1 };
    const handleContentChange = () => {
      // 用户在看历史时不抢滚动控制权，也省掉这次布局读取。
      if (!followLatestRef.current) {
        return;
      }

      const element = viewportRef.current;
      if (!element) {
        return;
      }

      const { scrollHeight, clientHeight } = element;
      if (scrollHeight === lastObserved.scrollHeight && clientHeight === lastObserved.clientHeight) {
        return;
      }

      lastObserved.scrollHeight = scrollHeight;
      lastObserved.clientHeight = clientHeight;
      scrollViewportToBottom();
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(handleContentChange)
      : null;
    resizeObserver?.observe(viewport);

    // 不订阅 attributes：会改变高度的属性变化必然引起盒子尺寸变化，已由
    // ResizeObserver 覆盖，无需为此承受高频属性回调。MutationObserver 负责
    // 只动 DOM/文本、尺寸读取时机更早的情况。
    const mutationObserver = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(handleContentChange)
      : null;
    mutationObserver?.observe(viewport, { childList: true, subtree: true, characterData: true });

    return () => {
      viewport.removeEventListener('scroll', updateScrollState);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [scrollViewportToBottom, updateScrollState, viewportRef]);

  useEffect(() => {
    if (forceFollow) {
      followLatestRef.current = true;
    }

    if (!followLatestRef.current) {
      return;
    }

    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }

    const scrollAfterFrames = (remainingFrames: number) => {
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        if (remainingFrames > 1) {
          scrollAfterFrames(remainingFrames - 1);
          return;
        }

        scrollFrameRef.current = null;
        if (!viewportRef.current || !followLatestRef.current) {
          return;
        }

        scrollViewportToBottom();
      });
    };

    scrollAfterFrames(Math.max(1, extraFrames));

    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [extraFrames, followKey, forceFollow, scrollViewportToBottom, viewportRef]);

  const scrollToBottom = useCallback(() => {
    followLatestRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (behavior !== 'auto' && typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      setIsAtBottom(true);
      return;
    }

    scrollViewportToBottom();
  }, [behavior, scrollViewportToBottom, viewportRef]);

  return { isAtBottom, scrollToBottom };
}
