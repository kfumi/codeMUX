import { describe, expect, it } from 'vitest';

import {
  BROWSER_REFERENCE_VIEWPORT,
  BROWSER_VIEWPORT_OPTIONS,
  browserViewportBounds,
  browserViewportDisplaySize,
  browserViewportTooltip,
  formatViewportSize,
  hostBoundsForViewportTransition,
} from './browserViewport';

describe('browserViewport', () => {
  it('labels fit mode as 自由尺寸 and percentages by value', () => {
    expect(browserViewportTooltip('fit')).toBe('自由尺寸');
    expect(browserViewportTooltip(50)).toBe('50%');
    expect(browserViewportTooltip(200)).toBe('200%');
  });

  it('uses the reference mobile viewport and centers it inside the host', () => {
    expect(browserViewportDisplaySize(100)).toEqual(BROWSER_REFERENCE_VIEWPORT);
    expect(browserViewportDisplaySize(50)).toEqual({ width: 197, height: 426 });
    expect(browserViewportDisplaySize('fit', { width: 200, height: 900 })).toEqual({
      width: 200,
      height: 434,
    });

    expect(browserViewportBounds({ x: 100, y: 200, width: 800, height: 900 }, 'fit')).toEqual({
      x: 100,
      y: 200,
      width: 800,
      height: 900,
    });
    expect(browserViewportBounds({ x: 100, y: 200, width: 800, height: 900 }, 'fit', true)).toEqual({
      x: 100 + (800 - 393) / 2,
      y: 200 + (900 - 852) / 2,
      width: 393,
      height: 852,
    });
    expect(browserViewportBounds({ x: 100, y: 200, width: 800, height: 900 }, 100, true)).toEqual({
      x: 100 + (800 - 393) / 2,
      y: 200 + (900 - 852) / 2,
      width: 393,
      height: 852,
    });
  });

  it('exposes the size menu options in order', () => {
    expect(BROWSER_VIEWPORT_OPTIONS.map((option) => option.label)).toEqual([
      '适应窗口',
      '50%',
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
    ]);
  });

  it('formats the current viewport size', () => {
    expect(formatViewportSize(393.4, 852.2)).toBe('393 × 852');
  });

  it('reserves chrome height when entering preview mode before layout remeasures', () => {
    const fitHost = { x: 10, y: 20, width: 800, height: 900 };
    expect(hostBoundsForViewportTransition(fitHost, false, true)).toEqual({
      x: 10,
      y: 52,
      width: 800,
      height: 868,
    });

    const previewHost = { x: 10, y: 52, width: 800, height: 868 };
    expect(hostBoundsForViewportTransition(previewHost, true, false)).toEqual(fitHost);
  });
});
