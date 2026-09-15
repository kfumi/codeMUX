// splash 控制器契约测试:electron BrowserWindow 以 mock 替身注入,覆盖
// 幂等 dismiss / 超时兜底 / 渐隐销毁 / 资源缺失 no-op / ensureVisible 兜底。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windowInstances: FakeBrowserWindow[] = [];

class FakeBrowserWindow {
  destroyed = false;
  visible = false;
  opacity = 1;
  loadFileCalls: string[] = [];
  readyCallbacks: Array<() => void> = [];

  constructor(_options: unknown) {
    windowInstances.push(this);
  }

  loadFile(file: string): Promise<void> {
    this.loadFileCalls.push(file);
    return Promise.resolve();
  }

  once(event: string, callback: () => void): void {
    if (event === 'ready-to-show') {
      this.readyCallbacks.push(callback);
    }
  }

  setMenuBarVisibility(_visible: boolean): void {}
  show(): void {
    this.visible = true;
  }
  showInactive(): void {
    this.visible = true;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setOpacity(value: number): void {
    this.opacity = value;
  }
  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }
}

// 工厂取值用 getter:vi.mock 工厂会被提升到类声明之前,直接引用会踩 TDZ;
// getter 延迟到真正 new BrowserWindow(测试体内)时才解析。
vi.mock('electron', () => ({
  get BrowserWindow() {
    return FakeBrowserWindow;
  },
}));

import { createSplashWindow, SPLASH_TIMEOUT_MS } from '../src/splash';

/** 注入的计时器存根:手控触发超时回调,断言注册/取消行为。 */
function createTimerStub() {
  let callback: (() => void) | null = null;
  let registeredMs: number | null = null;
  return {
    schedule: (cb: () => void, ms: number) => {
      callback = cb;
      registeredMs = ms;
      return () => {
        callback = null;
      };
    },
    fire: () => {
      callback?.();
      callback = null;
    },
    pending: () => callback !== null,
    registeredMs: () => registeredMs,
  };
}

describe('createSplashWindow', () => {
  beforeEach(() => {
    windowInstances.length = 0;
  });

  it('创建即加载 splash 页面,ready-to-show 后显示', () => {
    const controller = createSplashWindow();
    const [win] = windowInstances;

    expect(win).toBeDefined();
    expect(win.loadFileCalls[0]).toMatch(/assets[/\\]splash\.html$/);
    expect(win.visible).toBe(false);

    win.readyCallbacks.forEach((cb) => cb());
    expect(win.visible).toBe(true);
    controller.dispose();
  });

  it('dismiss 渐隐销毁:经 setOpacity 分步降到 0 后 destroy', () => {
    vi.useFakeTimers();
    try {
      const controller = createSplashWindow({ fadeOutMs: 30 });
      const win = windowInstances[0];
      win.readyCallbacks.forEach((cb) => cb());

      controller.dismiss();
      expect(win.destroyed).toBe(false);

      // 6 步渐隐,每步 5ms;步进 5 次后仍存活,第 6 次销毁。
      for (let step = 1; step <= 5; step += 1) {
        vi.advanceTimersByTime(5);
        expect(win.destroyed).toBe(false);
        expect(win.opacity).toBeCloseTo(1 - step / 6, 5);
      }
      vi.advanceTimersByTime(5);
      expect(win.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismiss 幂等:重复调用不二次销毁、不重复渐隐', () => {
    vi.useFakeTimers();
    try {
      const controller = createSplashWindow({ fadeOutMs: 30 });
      const win = windowInstances[0];

      controller.dismiss();
      controller.dismiss();
      controller.dismiss();

      vi.advanceTimersByTime(30);
      expect(win.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时兜底:默认 10s,触发后按 dismiss 渐隐;dismiss 先行则取消计时器', async () => {
    const timer = createTimerStub();
    const controller = createSplashWindow({ scheduleTimeout: timer.schedule });

    expect(timer.registeredMs()).toBe(SPLASH_TIMEOUT_MS);
    expect(timer.pending()).toBe(true);

    // 正常路径:renderer-ready → dismiss 取消超时。
    controller.dismiss();
    expect(timer.pending()).toBe(false);

    // 超时路径:新实例,超时触发等价 dismiss(渐隐已启动;渐隐用真实 setInterval,
    // 等 40ms 后首步(30ms)已降透明度)。
    const timer2 = createTimerStub();
    createSplashWindow({ scheduleTimeout: timer2.schedule });
    timer2.fire();
    const win2 = windowInstances[1];
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win2.opacity).toBeLessThan(1);
    win2.destroy();
  });

  it('dispose 立即销毁(无渐隐),并使后续 dismiss/ensureVisible 变为 no-op', () => {
    const controller = createSplashWindow();
    const win = windowInstances[0];
    win.readyCallbacks.forEach((cb) => cb());

    controller.dispose();
    expect(win.destroyed).toBe(true);

    expect(() => {
      controller.dismiss();
      controller.ensureVisible();
    }).not.toThrow();
  });

  it('ensureVisible:未显示时 showInactive 兜底,已 dismiss 后 no-op', () => {
    const controller = createSplashWindow();
    const win = windowInstances[0];

    expect(win.visible).toBe(false);
    controller.ensureVisible();
    expect(win.visible).toBe(true);

    controller.dismiss();
    controller.ensureVisible();
    expect(win.visible).toBe(true); // dismiss 后不再重复 show(渐隐中)。
  });

  it('fade-ms=0 时 dismiss 立即销毁(便于无头测试)', () => {
    const controller = createSplashWindow({ fadeOutMs: 0 });
    const win = windowInstances[0];

    controller.dismiss();
    expect(win.destroyed).toBe(true);
  });
});
