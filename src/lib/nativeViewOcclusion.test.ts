// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearOccluders,
  isBoundsOccluded,
  isRectOccluded,
  registerOccluder,
  unregisterOccluder,
} from './nativeViewOcclusion';

describe('nativeViewOcclusion', () => {
  beforeEach(() => {
    clearOccluders();
  });

  it('detects intersection between host bounds and registered occluders', () => {
    registerOccluder('menu', { x: 100, y: 100, width: 80, height: 120 });

    expect(isRectOccluded({ x: 120, y: 150, width: 400, height: 300 })).toBe(true);
    expect(isBoundsOccluded({ x: 0, y: 0, width: 80, height: 80 })).toBe(false);
  });

  it('clears occlusion after unregistering the occluder', () => {
    registerOccluder('menu', { x: 10, y: 10, width: 50, height: 50 });
    unregisterOccluder('menu');

    expect(isRectOccluded({ x: 20, y: 20, width: 200, height: 200 })).toBe(false);
  });
});
