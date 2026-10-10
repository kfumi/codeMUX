// 控制中提示条窗口层契约测试(工单 10;窗口复用、每次显示重申置顶、光标所在显示器定位、
// 显示器变化重定位与 fail-hidden 见工单 18)。
//
// 这一层原先直接 `new BrowserWindow(...)`,任何行为都只能靠人工开应用验证;现在建窗、
// 取工作区、显示器订阅与定时都从 deps 注入,于是用假窗口 + 假时钟即可钉死这些不变量。
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import {
  CONTROL_BANNER_LEAVE_ANIMATION_MS,
  CONTROL_BANNER_TOP_OFFSET,
  CONTROL_BANNER_WIDTH,
  bannerWindowOptions,
  type BannerBounds,
} from '../src/control-banner';
import {
  createControlBannerWindow,
  type BannerWindowLike,
  type ControlBannerWindowDeps,
} from '../src/control-banner-window';

const ACTIVATE = "document.documentElement.dataset.state='active'";
const LEAVE = "document.documentElement.dataset.state='leaving'";

const PRIMARY: BannerBounds = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY: BannerBounds = { x: 1920, y: 0, width: 1280, height: 1024 };

class FakeBannerWindow implements BannerWindowLike {
  readonly options: ReturnType<typeof bannerWindowOptions>;
  readonly loads: string[] = [];
  readonly scripts: string[] = [];
  readonly topFlags: boolean[] = [];
  readonly topLevels: Array<string | undefined> = [];
  readonly bounds: BannerBounds[] = [];
  moveTopCount = 0;
  hiddenCount = 0;
  destroyed = false;
  visible = false;
  /** 页面的 data-state(见 control-banner.ts 的页面):新文档一律从 leaving 起步。 */
  dataState = 'leaving';
  ignoreMouseEvents: boolean | null = null;
  contentProtection: boolean | null = null;
  hideThrows = false;
  current: BannerBounds;
  private readonly closedHandlers: Array<() => void> = [];
  readonly webContents = {
    executeJavaScript: (code: string): Promise<unknown> => {
      this.scripts.push(code);
      // 页面里的脚本只干一件事:改 data-state。
      if (code.includes("'active'")) this.dataState = 'active';
      if (code.includes("'leaving'")) this.dataState = 'leaving';
      return Promise.resolve(undefined);
    },
  };

  constructor(options: ReturnType<typeof bannerWindowOptions>) {
    this.options = options;
    this.current = options;
  }

  loadURL(url: string): Promise<void> {
    this.loads.push(url);
    // 导航提交会**换掉整个文档**:先前针对旧文档执行的脚本连同 data-state 一起丢掉。
    return Promise.resolve().then(() => {
      this.dataState = 'leaving';
    });
  }

  showInactive(): void {
    this.visible = true;
  }

  hide(): void {
    if (this.hideThrows) throw new Error('hide failed');
    this.visible = false;
    this.hiddenCount += 1;
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void {
    this.topFlags.push(flag);
    this.topLevels.push(level);
  }

  moveTop(): void {
    this.moveTopCount += 1;
  }

  setBounds(bounds: BannerBounds): void {
    this.current = bounds;
    this.bounds.push(bounds);
  }

  getBounds(): BannerBounds {
    return this.current;
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    this.ignoreMouseEvents = ignore;
  }

  setContentProtection(enable: boolean): void {
    this.contentProtection = enable;
  }

  on(event: 'closed', listener: () => void): unknown {
    if (event === 'closed') this.closedHandlers.push(listener);
    return this;
  }

  /** 模拟系统把它关掉(任务管理器 / 显示器拔插等)。 */
  closeBySystem(): void {
    this.destroyed = true;
    this.visible = false;
    for (const handler of this.closedHandlers) handler();
  }
}

/** 只有显式 advance 才前进的假时钟:两种定时器(置顶重申、离场/重建)都在同一时间轴上。 */
function createClock() {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let nextId = 1;
  return {
    schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(timer: ReturnType<typeof setTimeout>): void {
      timers.delete(timer as unknown as number);
    },
    advance(delayMs: number): void {
      const target = now + delayMs;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    get pending(): number {
      return timers.size;
    },
  };
}

function createHarness(
  overrides: Partial<ControlBannerWindowDeps> = {},
  resolveWorkArea: (anchor: BannerBounds | null) => BannerBounds = () => PRIMARY,
) {
  const created: FakeBannerWindow[] = [];
  const clock = createClock();
  const log = vi.fn();
  let displayHandler: (() => void) | null = null;
  const unsubscribeDisplay = vi.fn(() => {
    displayHandler = null;
  });
  const deps: ControlBannerWindowDeps = {
    createWindow: (options) => {
      const window = new FakeBannerWindow(options);
      created.push(window);
      return window;
    },
    resolveWorkArea,
    subscribeDisplayChanges: (handler) => {
      displayHandler = handler;
      return unsubscribeDisplay;
    },
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    cancel: (timer) => clock.cancel(timer),
    log,
    ...overrides,
  };
  return {
    deps,
    created,
    clock,
    log,
    unsubscribeDisplay,
    latest: () => created[created.length - 1],
    fireDisplayChange: () => displayHandler?.(),
  };
}

/** 把「loadURL 落地 → 我们补写状态」这条微任务链跑到底。 */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await Promise.resolve();
  }
}

describe('control banner 窗口层', () => {
  it('creates one non-focusable, click-through, capture-excluded window and loads the pill', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);

    expect(handle.setVisible(true)).toBe(true);

    const window = harness.latest();
    expect(harness.created).toHaveLength(1);
    expect(window?.loads[0]?.startsWith('data:text/html')).toBe(true);
    expect(window?.options.focusable).toBe(false);
    expect(window?.options.skipTaskbar).toBe(true);
    // 点击穿透与内容保护:提示条既不挡鼠标,也不进 driver 的截图。
    expect(window?.ignoreMouseEvents).toBe(true);
    expect(window?.contentProtection).toBe(true);
    expect(window?.visible).toBe(true);
    expect(window?.scripts).toContain(ACTIVATE);
    expect(window?.topLevels).toEqual(['screen-saver']);
    expect(window?.moveTopCount).toBe(1);
  });

  it('hides after the leave animation and reuses the same window next time', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    expect(handle.setVisible(false)).toBe(true);
    expect(window?.scripts).toContain(LEAVE);

    // 动画没播完之前窗口仍在屏幕上(否则会看到一帧硬切)。
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS - 1);
    expect(window?.hiddenCount).toBe(0);

    harness.clock.advance(1);
    expect(window?.hiddenCount).toBe(1);
    expect(window?.destroyed).toBe(false);

    // 下一段操作复用同一个窗口:不重新建窗,也不重新加载页面(这正是省下来的延迟)。
    expect(handle.setVisible(true)).toBe(true);
    expect(harness.created).toHaveLength(1);
    expect(window?.loads).toHaveLength(1);
    expect(window?.visible).toBe(true);
  });

  it('cancels a pending hide when the next episode starts inside the leave animation', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    handle.setVisible(false);
    handle.setVisible(true);
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS * 2);

    expect(window?.hiddenCount).toBe(0);
    expect(window?.visible).toBe(true);
  });

  it('re-asserts always-on-top on every show (Windows drops WS_EX_TOPMOST while hidden)', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);

    handle.setVisible(true);
    handle.setVisible(false);
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS);
    handle.setVisible(true);

    const window = harness.latest();
    expect(window?.topFlags).toEqual([true, true]);
    expect(window?.topLevels).toEqual(['screen-saver', 'screen-saver']);
    expect(window?.moveTopCount).toBe(2);
  });

  it('positions on the display the resolver picks and follows display changes', () => {
    // 显示时按光标所在显示器(anchor=null);显示器增删时按窗口当前所在矩形重定位。
    const harness = createHarness({}, (anchor) => (anchor ? SECONDARY : PRIMARY));
    const handle = createControlBannerWindow(harness.deps);

    handle.setVisible(true);
    const window = harness.latest();
    expect(window?.current.x + (window?.current.width ?? 0) / 2).toBe(PRIMARY.width / 2);
    expect(window?.current.y).toBe(PRIMARY.y + CONTROL_BANNER_TOP_OFFSET);

    harness.fireDisplayChange();

    const moved = window?.current;
    expect(moved?.x).toBe(SECONDARY.x + (SECONDARY.width - CONTROL_BANNER_WIDTH) / 2);
    expect(window?.bounds).toHaveLength(2);
  });

  it('keeps re-asserting on top while visible and stops once hidden', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();
    const initial = window?.topFlags.length ?? 0;

    harness.clock.advance(2000);
    expect(window?.topFlags.length).toBe(initial + 1);
    harness.clock.advance(2000);
    expect(window?.topFlags.length).toBe(initial + 2);

    handle.setVisible(false);
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS);
    const atHide = window?.topFlags.length ?? 0;
    harness.clock.advance(10_000);

    expect(window?.topFlags.length).toBe(atHide);
  });

  it('destroys the window when hiding fails (fail-hidden, never a false claim)', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();
    if (window) window.hideThrows = true;

    handle.setVisible(false);
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS);

    expect(window?.destroyed).toBe(true);
    expect(harness.log).toHaveBeenCalledWith('warn', expect.stringContaining('隐藏失败'));
  });

  it('reports a failed hide when the leave timer cannot even be scheduled', () => {
    let scheduled = 0;
    const harness = createHarness({
      schedule: (callback, delayMs) => {
        scheduled += 1;
        // 第一次是置顶重申(显示时),第二次才是离场定时器:只让后者失败。
        if (scheduled > 1) throw new Error('定时器不可用');
        return setTimeout(callback, delayMs);
      },
    });
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    // 隐藏没做成 → 不能只说「已隐藏」:句柄要报废,窗口层要如实回 false。
    expect(handle.setVisible(false)).toBe(false);
    expect(window?.destroyed).toBe(true);
  });

  it('stays hidden and says so when the window cannot be created', () => {
    const harness = createHarness({
      createWindow: () => {
        throw new Error('没有显示器');
      },
    });
    const handle = createControlBannerWindow(harness.deps);

    expect(handle.setVisible(true)).toBe(false);
    expect(harness.log).toHaveBeenCalledWith('warn', expect.stringContaining('创建失败'));
  });

  it('rebuilds the window if the system closes it while it should be visible', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);

    harness.latest()?.closeBySystem();
    harness.clock.advance(250);

    expect(harness.created).toHaveLength(2);
    expect(harness.latest()?.visible).toBe(true);
  });

  it('does not rebuild after an explicit hide', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    handle.setVisible(false);
    harness.clock.advance(CONTROL_BANNER_LEAVE_ANIMATION_MS);
    window?.closeBySystem();
    harness.clock.advance(1000);

    expect(harness.created).toHaveLength(1);
  });

  it('dispose destroys the window, unsubscribes and leaves no timer behind', () => {
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    handle.dispose();

    expect(window?.destroyed).toBe(true);
    expect(harness.unsubscribeDisplay).toHaveBeenCalledTimes(1);
    expect(harness.clock.pending).toBe(0);
  });

  it('keeps the pill on screen at the very first show (page load must not wipe the enter state)', async () => {
    // 首次显示时 reveal 的 executeJavaScript 可能落在导航提交**前**的文档上:新文档一提交
    // 就把状态丢掉,于是窗口留在屏幕上、服务层与看门狗都认为显示成功,而 pill 停在 leaving
    // (opacity 0)—— 正是本工单要修的那类「操作已经开始却看不见提示条」。
    const harness = createHarness();
    const handle = createControlBannerWindow(harness.deps);
    handle.setVisible(true);
    const window = harness.latest();

    await flushMicrotasks();

    expect(window?.dataState).toBe('active');
  });

  it('reports a lost window when the self-heal rebuild fails', () => {
    // 服务层的记账只能靠这个上报改回来:否则它会一直认为提示条在屏幕上,把后面的显示
    // 请求全短路掉,这一整段操作里提示条再也回不来。
    const onVisibilityLost = vi.fn();
    const harness = createHarness({ onVisibilityLost });
    const createOnce = harness.deps.createWindow;
    if (!createOnce) throw new Error('harness 必须提供 createWindow');
    let calls = 0;
    harness.deps.createWindow = (options) => {
      calls += 1;
      if (calls > 1) throw new Error('没有显示器');
      return createOnce(options);
    };
    const handle = createControlBannerWindow(harness.deps);

    handle.setVisible(true);
    harness.latest()?.closeBySystem();
    harness.clock.advance(250);

    expect(onVisibilityLost).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith('warn', expect.stringContaining('重建失败'));

    // 上报之后就结束:同一段操作里不该每 250ms 再试一次建窗。
    harness.clock.advance(10_000);
    expect(onVisibilityLost).toHaveBeenCalledTimes(1);
  });
});
