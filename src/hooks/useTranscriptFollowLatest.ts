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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    updateScrollState();
    viewport.addEventListener('scroll', updateScrollState, { passive: true });
    return () => viewport.removeEventListener('scroll', updateScrollState);
  }, [updateScrollState, viewportRef]);

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
        const viewport = viewportRef.current;
        if (!viewport || !followLatestRef.current) {
          return;
        }

        const nextScrollHeight = viewport.scrollHeight;
        viewport.scrollTop = nextScrollHeight;
        lastScrollTopRef.current = viewport.scrollTop;
        lastScrollHeightRef.current = nextScrollHeight;
        setIsAtBottom(true);
      });
    };

    scrollAfterFrames(Math.max(1, extraFrames));

    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [extraFrames, followKey, forceFollow, viewportRef]);

  const scrollToBottom = useCallback(() => {
    followLatestRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (behavior !== 'auto' && typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    setIsAtBottom(true);
  }, [behavior, viewportRef]);

  return { isAtBottom, scrollToBottom };
}
