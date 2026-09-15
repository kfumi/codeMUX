// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BridgeStub = { notifyRendererReady: ReturnType<typeof vi.fn> };

/** 安装/还原 window.codemuxDesktop 桩(desktopBridge 以 typeof window 探测)。 */
function installBridge(stub: BridgeStub | undefined): void {
  if (stub) {
    (window as unknown as { codemuxDesktop?: BridgeStub }).codemuxDesktop = stub;
  } else {
    delete (window as unknown as { codemuxDesktop?: BridgeStub }).codemuxDesktop;
  }
}

describe('notifyRendererReady', () => {
  const rafCallbacks: FrameRequestCallback[] = [];
  const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });

  beforeEach(() => {
    vi.resetModules(); // rendererReady 模块级 once 状态(desktopBridge 捕获、notified)逐用例重置。
    rafCallbacks.length = 0;
  });

  afterEach(() => {
    installBridge(undefined);
    requestAnimationFrameSpy.mockClear();
  });

  /** 桥安装后动态导入:desktopBridge 在模块求值时捕获,必须后于 stub 安装加载。 */
  async function loadModule(): Promise<typeof import('./rendererReady')> {
    return import('./rendererReady');
  }

  /** 推进双 RAF(渲染层上报的固定时机)。 */
  async function flushTwoFrames(): Promise<void> {
    for (let frame = 0; frame < 2; frame += 1) {
      const callbacks = rafCallbacks.splice(0);
      callbacks.forEach((cb) => cb(performance.now()));
      await Promise.resolve();
    }
    // resolve → .then(上报) 的微任务链再让一步,确保断言时已执行。
    await Promise.resolve();
  }

  it('挂载后经双 RAF 上报 notifyRendererReady', async () => {
    const stub: BridgeStub = { notifyRendererReady: vi.fn().mockResolvedValue(undefined) };
    installBridge(stub);
    const { notifyRendererReady } = await loadModule();

    notifyRendererReady();
    expect(stub.notifyRendererReady).not.toHaveBeenCalled();

    await flushTwoFrames();
    expect(stub.notifyRendererReady).toHaveBeenCalledTimes(1);
  });

  it('幂等:StrictMode 双挂载 / 热重载只上报一次', async () => {
    const stub: BridgeStub = { notifyRendererReady: vi.fn().mockResolvedValue(undefined) };
    installBridge(stub);
    const { notifyRendererReady } = await loadModule();

    notifyRendererReady();
    notifyRendererReady();
    notifyRendererReady();

    await flushTwoFrames();
    expect(stub.notifyRendererReady).toHaveBeenCalledTimes(1);
  });

  it('非 Electron 形态(无桥)为 no-op,不抛错', async () => {
    installBridge(undefined);
    const { notifyRendererReady } = await loadModule();

    expect(() => notifyRendererReady()).not.toThrow();
    await flushTwoFrames();
  });

  it('壳侧拒绝被静默吞掉(超时兜底自会收场)', async () => {
    const stub: BridgeStub = { notifyRendererReady: vi.fn().mockRejectedValue(new Error('gone')) };
    installBridge(stub);
    const { notifyRendererReady } = await loadModule();

    expect(() => notifyRendererReady()).not.toThrow();
    await flushTwoFrames();
    expect(stub.notifyRendererReady).toHaveBeenCalledTimes(1);
  });
});
