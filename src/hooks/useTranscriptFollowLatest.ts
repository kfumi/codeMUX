import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAgentStore } from '../stores/agentStore';

export function isTranscriptViewportAtBottom(viewport: HTMLDivElement): boolean {
  return viewport.scrollHeight <= viewport.clientHeight
    || Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
}

export function useTranscriptFollowLatest({
  viewportRef,
  followKey,
  extraFrames = 1,
  forceFollow = false,
  followSessionId,
}: {
  viewportRef: RefObject<HTMLDivElement>;
  followKey: unknown;
  extraFrames?: number;
  forceFollow?: boolean;
  /**
   * Session whose streaming flushes should keep the viewport pinned to the
   * bottom. Those flushes fire tens of times per second, so they are consumed
   * through an imperative store subscription instead of a React-rendered value:
   * folding them into `followKey` re-rendered the entire viewport subtree on
   * every flush just to schedule a scroll that needs no render at all.
   */
  followSessionId?: string;
}) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const followLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  // Read by the imperative streaming subscription, which must not re-subscribe
  // when extraFrames changes.
  const extraFramesRef = useRef(extraFrames);
  extraFramesRef.current = extraFrames;

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
    let contentFrame: number | null = null;

    const flushContentChange = () => {
      contentFrame = null;

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

    // Reading scrollHeight/clientHeight forces a synchronous layout, and during
    // streaming the characterData mutation fires once per rendered token — i.e.
    // dozens of forced layouts per second, each one able to blow the frame
    // budget on its own. Coalescing into one read per frame keeps the same
    // "内容真正变化后再钉底" behaviour at a fraction of the layout cost, and
    // also merges the ResizeObserver and MutationObserver signals into one.
    const handleContentChange = () => {
      if (contentFrame !== null) {
        return;
      }

      contentFrame = window.requestAnimationFrame(flushContentChange);
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
      if (contentFrame !== null) {
        window.cancelAnimationFrame(contentFrame);
        contentFrame = null;
      }
    };
  }, [scrollViewportToBottom, updateScrollState, viewportRef]);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  // Shared by the followKey effect and the streaming signal subscription.
  // Entering it supersedes any pending frame so competing rAF chains cannot
  // stack up.
  const scheduleScrollAfterFrames = useCallback((frames: number) => {
    cancelScheduledScroll();

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

    scrollAfterFrames(Math.max(1, frames));
  }, [cancelScheduledScroll, scrollViewportToBottom, viewportRef]);

  useEffect(() => {
    if (forceFollow) {
      followLatestRef.current = true;
    }

    if (!followLatestRef.current) {
      return;
    }

    scheduleScrollAfterFrames(extraFrames);
  }, [extraFrames, followKey, forceFollow, scheduleScrollAfterFrames]);

  // Cancel a pending scroll on unmount only. The effect above intentionally does
  // not cancel in its cleanup: the streaming subscription below shares this
  // scheduler, so a cleanup firing on every followKey change would cancel frames
  // that subscription had just requested.
  useEffect(() => cancelScheduledScroll, [cancelScheduledScroll]);

  // Keep the viewport pinned while a stream streams, without rendering. Reading
  // streamingVersion as React state folded it into followKey, which re-rendered
  // this component — and the entire thread subtree it wraps — on every flush
  // just to schedule a scroll. The scroll only has to happen; it does not have
  // to be part of the rendered output.
  useEffect(() => {
    if (!followSessionId) {
      return;
    }

    const readVersion = (state: ReturnType<typeof useAgentStore.getState>) =>
      state.streamingVersion[followSessionId] ?? 0;

    let previous = readVersion(useAgentStore.getState());

    return useAgentStore.subscribe((state) => {
      const next = readVersion(state);
      if (next === previous) {
        return;
      }

      previous = next;
      if (!followLatestRef.current) {
        return;
      }

      scheduleScrollAfterFrames(extraFramesRef.current);
    });
  }, [extraFramesRef, followSessionId, scheduleScrollAfterFrames]);

  const scrollToBottom = useCallback(() => {
    followLatestRef.current = true;
    // 立即钉底。不要用 viewport.scrollTo({behavior:'smooth'}):实测 Chromium
    // 会把"用户点击手势里发起的平滑滚动"立刻取消,表现为按钮点了没反应;
    // 而钉底路径通用的 scrollTop 赋值在任何时机都可靠。
    scrollViewportToBottom();
  }, [scrollViewportToBottom]);

  return { isAtBottom, scrollToBottom };
}
