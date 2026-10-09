// 控制中提示条契约测试(工单 10):状态机(重复调用幂等、建窗失败降级、关窗
// 不抛)、窗口参数不变量(点击穿透/不抢焦点/不进任务栏),以及文案与页面内容。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_BANNER_MAX_VISIBLE_MS,
  CONTROL_BANNER_TEXT,
  bannerDataUrl,
  bannerHtml,
  bannerWindowOptions,
  createControlBannerService,
} from '../src/control-banner';

function bannerDeps(openImpl = () => ({ close: vi.fn() })) {
  return { open: vi.fn(openImpl), log: vi.fn() };
}

describe('control banner 状态机', () => {
  it('opens once while visible and closes on hide', () => {
    const handle = { close: vi.fn() };
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    banner.setVisible(true);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(true);

    banner.setVisible(false);
    banner.setVisible(false);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(false);
  });

  it('stays hidden (and says so) when the window cannot be created', () => {
    const deps = bannerDeps(() => {
      throw new Error('没有显示器');
    });
    const banner = createControlBannerService(deps);

    banner.setVisible(true);

    expect(banner.isVisible()).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('创建失败'));
  });

  it('swallows close errors so quitting is never blocked', () => {
    const deps = bannerDeps(() => ({
      close: () => {
        throw new Error('窗口已经没了');
      },
    }));
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    expect(() => banner.setVisible(false)).not.toThrow();
    expect(banner.isVisible()).toBe(false);
  });
});

describe('control banner 自动收起(工单 10 跟进)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides itself after the visible cap', () => {
    const handle = { close: vi.fn() };
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    expect(banner.isVisible()).toBe(true);

    vi.advanceTimersByTime(CONTROL_BANNER_MAX_VISIBLE_MS);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('自动收起'));
  });

  it('does not re-show while the same activity is still requested', () => {
    const open = vi.fn(() => ({ close: vi.fn() }));
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);
    vi.advanceTimersByTime(CONTROL_BANNER_MAX_VISIBLE_MS);
    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(false);
  });

  it('shows again for a new activity episode after an explicit hide', () => {
    const open = vi.fn(() => ({ close: vi.fn() }));
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);
    vi.advanceTimersByTime(CONTROL_BANNER_MAX_VISIBLE_MS);
    banner.setVisible(false);
    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(2);
    expect(banner.isVisible()).toBe(true);
  });

  it('clears a pending auto-hide when hidden explicitly first', () => {
    const handle = { close: vi.fn() };
    const banner = createControlBannerService(bannerDeps(() => handle));

    banner.setVisible(true);
    banner.setVisible(false);
    vi.advanceTimersByTime(CONTROL_BANNER_MAX_VISIBLE_MS * 2);

    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});

describe('control banner 窗口参数', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  it('never steals focus, clicks or a taskbar slot', () => {
    const options = bannerWindowOptions(workArea);
    expect(options.focusable).toBe(false);
    expect(options.skipTaskbar).toBe(true);
    expect(options.transparent).toBe(true);
    expect(options.frame).toBe(false);
    expect(options.alwaysOnTop).toBe(true);
    expect(options.backgroundColor).toBe('#00000000');
  });

  it('centers horizontally and sits near the top of the work area', () => {
    const options = bannerWindowOptions(workArea);
    expect(options.x + options.width / 2).toBe(960);
    expect(options.y).toBeGreaterThan(0);
    expect(options.y).toBeLessThan(workArea.height / 2);
  });

  it('clamps into the work area on tiny or offset displays', () => {
    const tiny = bannerWindowOptions({ x: 100, y: 50, width: 200, height: 100 });
    expect(tiny.x).toBeGreaterThanOrEqual(100);
    expect(tiny.y).toBeGreaterThanOrEqual(50);
    expect(tiny.y + tiny.height).toBeLessThanOrEqual(150);
  });
});

describe('control banner 页面', () => {
  it('states what is happening and that Esc stops it', () => {
    expect(CONTROL_BANNER_TEXT).toContain('Esc');
    const html = bannerHtml();
    expect(html).toContain(CONTROL_BANNER_TEXT);
    // 无脚本、无外链:提示条不能是一条可被利用的通道。
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http');
  });

  it('ships as a data URL so nothing has to be written to disk', () => {
    const url = bannerDataUrl();
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1] ?? '')).toContain(CONTROL_BANNER_TEXT);
  });
});
