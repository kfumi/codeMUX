// 控制中提示条契约测试(工单 10;常驻语义与顶部样式见工单 15):状态机(重复调用
// 幂等、建窗失败降级、关窗不抛、**不自动收起**)、窗口参数不变量(点击穿透/不抢
// 焦点/不进任务栏/贴顶部居中),以及文案与页面内容。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_BANNER_HINT,
  CONTROL_BANNER_TEXT,
  CONTROL_BANNER_TOP_OFFSET,
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

describe('control banner 常驻语义(工单 15)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays visible until it is hidden explicitly (no auto-hide)', () => {
    const handle = { close: vi.fn() };
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    expect(banner.isVisible()).toBe(true);

    // 之前这里 1s 就把窗口收掉;现在显示多久由渲染层的武装窗口决定。
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(handle.close).not.toHaveBeenCalled();
    expect(banner.isVisible()).toBe(true);

    banner.setVisible(false);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('已隐藏'));
  });

  it('keeps the same window across repeated requests while armed', () => {
    // 武装期间判据会随工具事件反复重算:同一段操作只开一次,不闪断、不重建。
    const open = vi.fn(() => ({ close: vi.fn() }));
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);
    vi.advanceTimersByTime(60_000);
    banner.setVisible(true);
    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(true);
  });

  it('shows a fresh window for the next episode after an explicit hide', () => {
    const open = vi.fn(() => ({ close: vi.fn() }));
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);
    banner.setVisible(false);
    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(2);
    expect(banner.isVisible()).toBe(true);
  });

  it('closes once and tolerates repeated hide requests', () => {
    const handle = { close: vi.fn() };
    const banner = createControlBannerService(bannerDeps(() => handle));

    banner.setVisible(true);
    banner.setVisible(false);
    banner.setVisible(false);
    vi.advanceTimersByTime(10_000);

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
    expect(options.y).toBe(workArea.y + CONTROL_BANNER_TOP_OFFSET);
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
    expect(CONTROL_BANNER_HINT).toContain('Esc');
    const html = bannerHtml();
    expect(html).toContain(CONTROL_BANNER_TEXT);
    expect(html).toContain(CONTROL_BANNER_HINT);
    // 无脚本、无外链:提示条不能是一条可被利用的通道。
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http');
  });

  it('renders the reference-style pill: three animated dots in a rounded bar', () => {
    const html = bannerHtml();
    expect(html).toContain('class="dots"');
    expect(html).toContain('@keyframes dots');
    expect(html).toContain('border-radius: 12px');
    // 三点呼吸与入场淡入都要尊重系统「减少动态效果」。
    expect(html).toContain('prefers-reduced-motion');
  });

  it('escapes both the main text and the hint', () => {
    const html = bannerHtml('<b>hi</b>', 'a & b');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('ships as a data URL so nothing has to be written to disk', () => {
    const url = bannerDataUrl();
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1] ?? '')).toContain(CONTROL_BANNER_TEXT);
  });
});
