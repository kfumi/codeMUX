import { useCallback, useLayoutEffect, type RefObject } from 'react';

import { useBrowserStore } from '../stores/browserStore';
import {
  occlusionRectFromDomRect,
  registerOccluder,
  unregisterOccluder,
} from './nativeViewOcclusion';

export function createBrowserOverlayOpenChangeHandler(
  setOpen: (open: boolean) => void,
) {
  return (open: boolean) => {
    setOpen(open);
    if (open) {
      useBrowserStore.getState().beginNativeMenuOpen();
    } else {
      useBrowserStore.getState().endNativeMenuOpen();
    }
  };
}

export function useBrowserOverlayOpenChange(setOpen: (open: boolean) => void) {
  return useCallback(
    (open: boolean) => createBrowserOverlayOpenChangeHandler(setOpen)(open),
    [setOpen],
  );
}

export function useNativeViewOccluder(
  id: string,
  active: boolean,
  elementRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    if (!active) {
      unregisterOccluder(id);
      return;
    }

    let frame = 0;
    const sync = () => {
      const element = elementRef.current;
      if (!element) {
        unregisterOccluder(id);
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        unregisterOccluder(id);
        return;
      }
      registerOccluder(id, occlusionRectFromDomRect(rect));
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };

    sync();
    const element = elementRef.current;
    if (!element) {
      return () => {
        if (frame) cancelAnimationFrame(frame);
        unregisterOccluder(id);
      };
    }

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      unregisterOccluder(id);
    };
  }, [active, id, elementRef]);
}

export function useBrowserDropdownHostGuard(
  id: string,
  open: boolean,
  elementRef: RefObject<HTMLElement | null>,
) {
  useNativeViewOccluder(id, open, elementRef);
}
