export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OCCLUSION_CHANGED_EVENT = 'codemux:native-view-occlusion-changed';

const occluders = new Map<string, OcclusionRect>();

function intersects(left: OcclusionRect, right: OcclusionRect): boolean {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
}

function notifyOcclusionChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OCCLUSION_CHANGED_EVENT));
}

export function registerOccluder(id: string, rect: OcclusionRect) {
  occluders.set(id, rect);
  notifyOcclusionChanged();
}

export function unregisterOccluder(id: string) {
  if (!occluders.delete(id)) return;
  notifyOcclusionChanged();
}

export function clearOccluders() {
  if (occluders.size === 0) return;
  occluders.clear();
  notifyOcclusionChanged();
}

export function isRectOccluded(rect: OcclusionRect): boolean {
  for (const occluder of occluders.values()) {
    if (intersects(rect, occluder)) return true;
  }
  return false;
}

export function isBoundsOccluded(bounds: OcclusionRect | undefined): boolean {
  if (!bounds || bounds.width < 2 || bounds.height < 2) return false;
  return isRectOccluded(bounds);
}

export function subscribeOcclusionChanged(listener: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OCCLUSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(OCCLUSION_CHANGED_EVENT, listener);
}

export function occlusionRectFromDomRect(rect: DOMRectReadOnly): OcclusionRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}
