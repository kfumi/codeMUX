import { useEffect, useState } from 'react';

import { MOBILE_VIEWPORT_MAX_WIDTH } from '../lib/host/host-form';

export const NARROW_VIEWPORT_QUERY = `(max-width: ${MOBILE_VIEWPORT_MAX_WIDTH}px)`;

function isNarrowNow(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
  }
  // jsdom 默认没有 matchMedia:退化为按视口宽度判断,仍能响应 resize。
  return window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH;
}

/**
 * 窄屏(手机/竖屏平板)判定(工单 03):响应式是布局问题而不是代码分叉,
 * 断点与宿主形态判定共用同一个阈值。
 */
export function useIsNarrowViewport(query: string = NARROW_VIEWPORT_QUERY): boolean {
  const [narrow, setNarrow] = useState(isNarrowNow);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia(query);
      const handler = (event: MediaQueryListEvent) => setNarrow(event.matches);
      setNarrow(media.matches);
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    const onResize = () => setNarrow(window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH);
    setNarrow(window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [query]);

  return narrow;
}
