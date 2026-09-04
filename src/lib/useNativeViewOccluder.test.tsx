// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';

import { clearOccluders, isRectOccluded } from './nativeViewOcclusion';
import { createBrowserOverlayOpenChangeHandler, useNativeViewOccluder } from './useNativeViewOccluder';
import { useBrowserStore } from '../stores/browserStore';

function OccluderFixture({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useNativeViewOccluder('fixture', active, ref);

  return (
    <div ref={ref} style={{ width: 120, height: 48 }}>
      menu
    </div>
  );
}

function flushAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('useNativeViewOccluder', () => {
  beforeEach(() => {
    clearOccluders();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      width: 120,
      height: 48,
      top: 20,
      left: 10,
      right: 130,
      bottom: 68,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    clearOccluders();
    vi.unstubAllGlobals();
  });

  it('registers the element bounds while active', async () => {
    render(<OccluderFixture active />);
    await flushAnimationFrame();

    expect(isRectOccluded({ x: 0, y: 0, width: 200, height: 200 })).toBe(true);
  });

  it('unregisters when inactive', () => {
    const { rerender } = render(<OccluderFixture active />);
    rerender(<OccluderFixture active={false} />);

    expect(isRectOccluded({ x: 0, y: 0, width: 200, height: 200 })).toBe(false);
  });

  it('hides browser hosts when an overlay opens', () => {
    const hideSpy = vi.spyOn(useBrowserStore.getState(), 'beginNativeMenuOpen');
    const setOpen = vi.fn();
    const handleOpenChange = createBrowserOverlayOpenChangeHandler(setOpen);

    handleOpenChange(true);

    expect(setOpen).toHaveBeenCalledWith(true);
    expect(hideSpy).toHaveBeenCalled();
    hideSpy.mockRestore();
  });
});
