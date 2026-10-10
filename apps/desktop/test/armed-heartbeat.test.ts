// 武装心跳看门狗契约测试(工单 18):提示条宣传「按 Esc 急停」,所以壳侧必须能在渲染层
// 失联(进程没了 / 主线程卡死 / WS 断链 / 回合状态卡在跑)时自己收起它 —— 参考实现
// (ZCode windowsCuaOperationIndicator)对同一类问题用的是 fail-hidden 计时器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARMED_HEARTBEAT_TIMEOUT_MS, createArmedHeartbeat } from '../src/armed-heartbeat';

describe('armed heartbeat watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onTimeout when no heartbeat arrives in time', () => {
    const onTimeout = vi.fn();
    const heartbeat = createArmedHeartbeat({ onTimeout, logger: { warn: vi.fn() } });

    heartbeat.beat();
    expect(heartbeat.isWatching()).toBe(true);

    vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS - 1000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(heartbeat.isWatching()).toBe(false);
  });

  it('restarts the countdown on every heartbeat', () => {
    // 渲染层每 5s 续期一次:任何一次心跳都必须把超时往后推,而不是累加到原截止时刻。
    const onTimeout = vi.fn();
    const heartbeat = createArmedHeartbeat({ onTimeout });

    heartbeat.beat();
    for (let round = 0; round < 5; round += 1) {
      vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS - 1000);
      heartbeat.beat();
    }

    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stops watching after stop() and never fires afterwards', () => {
    // 解除武装(回合结束)之后不该再留一个计时器,否则它会在下一次武装之前误收提示条。
    const onTimeout = vi.fn();
    const heartbeat = createArmedHeartbeat({ onTimeout });

    heartbeat.beat();
    heartbeat.stop();

    expect(heartbeat.isWatching()).toBe(false);

    vi.advanceTimersByTime(10 * ARMED_HEARTBEAT_TIMEOUT_MS);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('fires once per episode and counts a fresh beat after a timeout', () => {
    const onTimeout = vi.fn();
    const heartbeat = createArmedHeartbeat({ onTimeout });

    heartbeat.beat();
    vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS);
    // 超时收完之后渲染层又发来心跳(它卡顿完恢复了):从这一刻重新计时。
    heartbeat.beat();
    vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  it('keeps the watchdog usable when the timeout handler throws', () => {
    const heartbeat = createArmedHeartbeat({
      onTimeout: () => {
        throw new Error('收起提示条失败');
      },
      logger: { warn: vi.fn() },
    });

    heartbeat.beat();
    expect(() => vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS)).not.toThrow();

    heartbeat.beat();

    expect(heartbeat.isWatching()).toBe(true);
  });

  it('logs a warn line naming the timeout', () => {
    const warn = vi.fn();
    const heartbeat = createArmedHeartbeat({ onTimeout: vi.fn(), logger: { warn } });

    heartbeat.beat();
    vi.advanceTimersByTime(ARMED_HEARTBEAT_TIMEOUT_MS);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('心跳超时'));
  });
});
