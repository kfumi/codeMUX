// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  adjustAppZoom: vi.fn(),
  resetAppZoom: vi.fn(),
}));

vi.mock('../desktop-bridge', () => ({ desktopBridge: bridge }));

import { APP_ZOOM_STEP, resetAppZoom, zoomInApp, zoomOutApp } from './appZoom';

describe('appZoom', () => {
  beforeEach(() => {
    bridge.adjustAppZoom.mockReset().mockResolvedValue(0);
    bridge.resetAppZoom.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('放大与缩小按固定的 zoom level 步进交给壳侧', async () => {
    await zoomInApp();
    expect(bridge.adjustAppZoom).toHaveBeenCalledWith(APP_ZOOM_STEP);

    await zoomOutApp();
    expect(bridge.adjustAppZoom).toHaveBeenCalledWith(-APP_ZOOM_STEP);
  });

  it('恢复缩放不经过步进', async () => {
    await resetAppZoom();
    expect(bridge.resetAppZoom).toHaveBeenCalledTimes(1);
    expect(bridge.adjustAppZoom).not.toHaveBeenCalled();
  });

  it('壳侧失败只记警告，不向快捷键抛错', async () => {
    bridge.adjustAppZoom.mockRejectedValueOnce(new Error('boom'));
    await expect(zoomInApp()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
