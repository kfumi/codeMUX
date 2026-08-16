import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { ArrowDown } from 'lucide-react';

import { cn } from '../lib/utils';

const BOTTOM_THRESHOLD_PX = 80;

interface UseChatScrollToBottomOptions {
  /** Resets initial scroll when opening another session. */
  contentKey: string;
  loading: boolean;
  contentLength: number;
  rowCount: number;
  /** Changes while streaming text/reasoning grows so the viewport can follow. */
  streamTick: number;
}

export function useChatScrollToBottom(
  viewportRef: RefObject<HTMLElement | null>,
  { contentKey, loading, contentLength, rowCount, streamTick }: UseChatScrollToBottomOptions,
) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [contentVisible, setContentVisible] = useState(false);
  const followLatestRef = useRef(true);
  const initialScrollPendingRef = useRef(true);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
    setIsAtBottom(atBottom);
    followLatestRef.current = atBottom;
  }, [viewportRef]);

  const scrollToEndInstant = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
    followLatestRef.current = true;
    setIsAtBottom(true);
  }, [viewportRef]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    followLatestRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    setIsAtBottom(true);
  }, [viewportRef]);

  const followLatestIfNeeded = useCallback(() => {
    if (!followLatestRef.current) {
      return;
    }
    scrollToEndInstant();
  }, [scrollToEndInstant]);

  useEffect(() => {
    initialScrollPendingRef.current = true;
    followLatestRef.current = true;
    setContentVisible(false);
    setIsAtBottom(true);
  }, [contentKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const handleScroll = () => updateScrollState();
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    updateScrollState();
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [contentKey, updateScrollState, viewportRef]);

  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    if (contentLength === 0) {
      initialScrollPendingRef.current = false;
      setContentVisible(true);
      return;
    }

    if (!initialScrollPendingRef.current) {
      return;
    }

    scrollToEndInstant();

    const frame = window.requestAnimationFrame(() => {
      scrollToEndInstant();
      window.requestAnimationFrame(() => {
        scrollToEndInstant();
        initialScrollPendingRef.current = false;
        setContentVisible(true);
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contentLength, loading, rowCount, scrollToEndInstant]);

  useEffect(() => {
    if (loading || !initialScrollPendingRef.current) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (initialScrollPendingRef.current) {
        scrollToEndInstant();
      }
    });

    observer.observe(viewport);
    for (const child of viewport.children) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [contentLength, loading, rowCount, scrollToEndInstant, viewportRef]);

  useLayoutEffect(() => {
    if (loading || initialScrollPendingRef.current) {
      return;
    }
    followLatestIfNeeded();
  }, [followLatestIfNeeded, loading, rowCount, streamTick]);

  return {
    isAtBottom,
    contentVisible,
    scrollToBottom,
    followLatestIfNeeded,
  };
}

interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({ visible, onClick }: ScrollToBottomButtonProps) {
  return (
    <button
      type="button"
      aria-label="回到底部"
      className={cn(
        'absolute -top-12 left-1/2 z-10 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-[hsl(var(--surface-2))] text-muted-foreground shadow-lg transition-all hover:text-foreground',
        !visible && 'pointer-events-none opacity-0',
      )}
      onClick={onClick}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
