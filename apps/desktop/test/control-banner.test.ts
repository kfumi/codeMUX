// 控制中提示条契约测试(工单 10;常驻语义与顶部样式见工单 15;窗口复用与 fail-hidden
// 见工单 18):状态机(重复调用幂等、建窗/显示/隐藏失败一律不谎称成功、**不自动收起**、
// 隐藏只离场不销毁窗口、dispose 才销毁)、窗口参数不变量(点击穿透/不抢焦点/不进任务栏/
// 贴顶部居中),以及文案与页面内容。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_BANNER_HINT,
  CONTROL_BANNER_TEXT,
  CONTROL_BANNER_TOP_OFFSET,
  bannerDataUrl,
  bannerHtml,
  bannerWindowOptions,
  createControlBannerService,
  type ControlBannerHandle,
} from '../src/control-banner';

function bannerHandle(setVisibleImpl: (visible: boolean) => boolean = () => true): {
  setVisible: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} & ControlBannerHandle {
  return { setVisible: vi.fn(setVisibleImpl), dispose: vi.fn() };
}

function bannerDeps(openImpl: () => ControlBannerHandle = () => bannerHandle()) {
  return { open: vi.fn(openImpl), log: vi.fn() };
}

describe('control banner 状态机', () => {
  it('shows once while armed and keeps the window for the next episode', () => {
    const handle = bannerHandle();
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    banner.setVisible(true);
    // 武装期间判据会随工具事件反复重算:重复请求不该反复打扰窗口层。
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(handle.setVisible).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(true);

    banner.setVisible(false);
    banner.setVisible(false);
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    expect(banner.isVisible()).toBe(false);
    // 工单 18:隐藏只是离场,窗口留着复用 —— 否则下一段操作要等建窗 + 页面加载。
    expect(handle.dispose).not.toHaveBeenCalled();

    banner.setVisible(true);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(banner.isVisible()).toBe(true);
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

  it('treats a failed show as not shown and rebuilds the window next time', () => {
    const broken = bannerHandle(() => false);
    const healthy = bannerHandle();
    const open = vi
      .fn<() => ControlBannerHandle>()
      .mockReturnValueOnce(broken)
      .mockReturnValueOnce(healthy);
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);

    // 没显示成就不能记成已显示,否则下一段操作会以为提示条已经在屏幕上。
    expect(banner.isVisible()).toBe(false);
    expect(broken.dispose).toHaveBeenCalledTimes(1);

    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(2);
    expect(banner.isVisible()).toBe(true);
  });

  it('treats an unconfirmed hide as not hidden (fail-hidden)', () => {
    // 隐藏没成功 = 屏幕上还挂着「按 Esc 急停」的提示:不能只把记账改成"已隐藏"。
    const handle = bannerHandle((visible) => visible);
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    banner.setVisible(false);

    expect(banner.isVisible()).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('隐藏未确认'));
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('swallows window errors so quitting is never blocked', () => {
    const handle: ControlBannerHandle = {
      setVisible: () => {
        throw new Error('窗口已经没了');
      },
      dispose: vi.fn(),
    };
    const banner = createControlBannerService(bannerDeps(() => handle));

    banner.setVisible(true);

    expect(banner.isVisible()).toBe(false);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('destroys the window only on dispose', () => {
    const handle = bannerHandle();
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    banner.dispose();
    banner.dispose();

    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(false);
  });

  it('stays disposed: a late show request cannot rebuild the window after quit', () => {
    // 退出等待期间渲染层的武装心跳会拿到 false 并重新声明武装,那条路径会再走一遍
    // setVisible(true):此时窗口已销毁,若还允许重建,退出过程里会闪出一条「正在操作电脑」
    // 的提示条并重新占住全局 Esc(工单 18)。
    const handle = bannerHandle();
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    banner.dispose();
    banner.setVisible(true);

    expect(deps.open).toHaveBeenCalledTimes(1);
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
    const handle = bannerHandle();
    const deps = bannerDeps(() => handle);
    const banner = createControlBannerService(deps);

    banner.setVisible(true);
    expect(banner.isVisible()).toBe(true);

    // 之前这里 1s 就把窗口收掉;现在显示多久由渲染层的武装窗口 + 壳侧心跳看门狗决定。
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(handle.setVisible).not.toHaveBeenCalledWith(false);
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(banner.isVisible()).toBe(true);

    banner.setVisible(false);

    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    expect(banner.isVisible()).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('info', expect.stringContaining('已隐藏'));
  });

  it('keeps the same window across repeated requests while armed', () => {
    // 武装期间判据会随工具事件反复重算:同一段操作只开一次,不闪断、不重建。
    const open = vi.fn(() => bannerHandle());
    const banner = createControlBannerService({ open, log: vi.fn() });

    banner.setVisible(true);
    vi.advanceTimersByTime(60_000);
    banner.setVisible(true);
    banner.setVisible(true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(banner.isVisible()).toBe(true);
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
    // 三点呼吸与入场/离场过渡都要尊重系统「减少动态效果」。
    expect(html).toContain('prefers-reduced-motion');
  });

  it('drives enter/leave from data-state (window is reused, page is not reloaded)', () => {
    const html = bannerHtml();
    // 以 leaving 起步:窗口复用后入场只能靠切状态触发过渡,首次显示也要有淡入。
    expect(html).toContain('data-state="leaving"');
    expect(html).toContain('html[data-state="active"] .pill');
    expect(html).toContain('transition: opacity 120ms ease, transform 120ms ease');
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
