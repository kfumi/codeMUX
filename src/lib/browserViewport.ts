import type { BrowserPageBounds } from './browserHost';

export type BrowserViewportMode = 'fit' | 50 | 75 | 100 | 125 | 150 | 200;

/** Height of the preview chrome bar (must match BrowserViewportChrome). */
export const BROWSER_VIEWPORT_CHROME_HEIGHT = 32;

/** Reference mobile viewport used for responsive preview (matches Paseo-style free-size). */
export const BROWSER_REFERENCE_VIEWPORT = {
  width: 393,
  height: 852,
} as const;

export const BROWSER_VIEWPORT_OPTIONS: { value: BrowserViewportMode; label: string }[] = [
  { value: 'fit', label: '适应窗口' },
  { value: 50, label: '50%' },
  { value: 75, label: '75%' },
  { value: 100, label: '100%' },
  { value: 125, label: '125%' },
  { value: 150, label: '150%' },
  { value: 200, label: '200%' },
];

export function browserViewportTooltip(mode: BrowserViewportMode): string {
  return mode === 'fit' ? '自由尺寸' : `${mode}%`;
}

export function browserViewportScaleLabel(mode: BrowserViewportMode): string {
  return BROWSER_VIEWPORT_OPTIONS.find((option) => option.value === mode)?.label ?? '适应窗口';
}

export function browserViewportDisplaySize(
  mode: BrowserViewportMode,
  host?: Pick<BrowserPageBounds, 'width' | 'height'>,
): Pick<BrowserPageBounds, 'width' | 'height'> {
  const scale = mode === 'fit'
    ? host
      ? Math.min(host.width / BROWSER_REFERENCE_VIEWPORT.width, host.height / BROWSER_REFERENCE_VIEWPORT.height, 1)
      : 1
    : mode / 100;
  return {
    width: Math.max(2, Math.round(BROWSER_REFERENCE_VIEWPORT.width * scale)),
    height: Math.max(2, Math.round(BROWSER_REFERENCE_VIEWPORT.height * scale)),
  };
}

export function browserViewportBounds(
  host: BrowserPageBounds,
  mode: BrowserViewportMode,
  previewActive = false,
): BrowserPageBounds {
  if (!previewActive) {
    return host;
  }

  const { width, height } = browserViewportDisplaySize(mode, host);
  const clampedWidth = Math.min(width, host.width);
  const clampedHeight = Math.min(height, host.height);

  return {
    x: host.x + (host.width - clampedWidth) / 2,
    y: host.y + (host.height - clampedHeight) / 2,
    width: clampedWidth,
    height: clampedHeight,
  };
}

export function formatViewportSize(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** Adjust stored host bounds when toggling preview chrome visibility before layout remeasures. */
export function hostBoundsForViewportTransition(
  bounds: BrowserPageBounds,
  previousPreview: boolean,
  nextPreview: boolean,
): BrowserPageBounds {
  if (!previousPreview && nextPreview) {
    return {
      ...bounds,
      y: bounds.y + BROWSER_VIEWPORT_CHROME_HEIGHT,
      height: Math.max(0, bounds.height - BROWSER_VIEWPORT_CHROME_HEIGHT),
    };
  }
  if (previousPreview && !nextPreview) {
    return {
      ...bounds,
      y: bounds.y - BROWSER_VIEWPORT_CHROME_HEIGHT,
      height: bounds.height + BROWSER_VIEWPORT_CHROME_HEIGHT,
    };
  }
  return bounds;
}
