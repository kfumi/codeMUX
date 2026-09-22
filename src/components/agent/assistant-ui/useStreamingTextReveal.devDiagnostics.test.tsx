// @vitest-environment jsdom
/**
 * 常开诊断的构建期 DEV 门控 —— 分帧绘制的平滑度采样这一路。
 *
 * 采样点 `recordRevealFrame(committed, now)` 在帧回调里**每帧**执行（流式期间
 * ≈60 次/秒，由常驻 rAF 循环驱动），读者只有 dev 性能浮层（`Ctrl+Shift+D`）
 * 与 `src/lib/dev/longSessionBenchmark.ts`。打包态里它没有任何读者，却要付
 * 两处 `pushCapped` 与一个 rAF 内的模块级写入，所以收进 `isDevDiagnosticsEnabled()`。
 *
 * 这里用**调用次数**锁门控（不涉及毫秒）：同一个假时钟下推进同样的帧，
 * DEV=true 必须有采样、DEV=false 必须一次都没有，且两臂的可见长度完全一致 ——
 * 门控只许砍掉诊断，不许顺带改掉绘制。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordRevealFrameMock } = vi.hoisted(() => ({ recordRevealFrameMock: vi.fn() }));

// 采样侧整块替换：本文件只关心"有没有调用"，不关心窗口统计本身
// （`streamSmoothness` 的统计口径由它自己的测试覆盖）。
vi.mock('@/lib/streamSmoothness', () => ({
  recordRevealFrame: recordRevealFrameMock,
  readAndResetSmoothness: vi.fn(),
  resetSmoothness: vi.fn(),
}));

import { resetRevealHorizonCache, useStreamingTextReveal } from './useStreamingTextReveal';

let clock = 0;
let frameQueue: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrameId = 1;

function installFrameClock(): void {
  clock = 1_000;
  frameQueue = [];
  nextFrameId = 1;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frameQueue.push({ id, callback });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameQueue = frameQueue.filter((entry) => entry.id !== id);
  });
}

/** 推进 n 帧，每帧 stepMs —— 只执行"本帧之前已排入"的回调，与真实 rAF 一致。 */
function runFrames(count: number, stepMs: number): void {
  for (let index = 0; index < count; index += 1) {
    clock += stepMs;
    const pending = frameQueue;
    frameQueue = [];
    act(() => {
      for (const entry of pending) {
        entry.callback(clock);
      }
    });
  }
}

type ProbeProps = { text: string; streaming: boolean };

function Probe({ text, streaming }: ProbeProps) {
  const revealed = useStreamingTextReveal(text, streaming);
  return <span data-testid="revealed">{revealed.length}</span>;
}

/** 复刻既有流式突发：20 个 tick × 3 帧（16ms）＝ 60 次帧回调，每 tick 追加 200 字。 */
const BURST_TICKS = 20;
const FRAMES_PER_TICK = 3;
const TOTAL_FRAMES = BURST_TICKS * FRAMES_PER_TICK;

/** 跑完一次突发，返回结束时屏上的可见长度（与 DEV 取值无关地可比较）。 */
function driveStreamingBurst(): number {
  let text = 'x'.repeat(50);
  const { rerender, getByTestId } = render(<Probe text={text} streaming />);

  for (let tick = 0; tick < BURST_TICKS; tick += 1) {
    runFrames(FRAMES_PER_TICK, 16);
    text += 'x'.repeat(200);
    const next = text;
    act(() => {
      rerender(<Probe text={next} streaming />);
    });
  }

  return Number(getByTestId('revealed').textContent);
}

describe('流式平滑度采样的 DEV 门控', () => {
  beforeEach(() => {
    installFrameClock();
    window.localStorage.clear();
    resetRevealHorizonCache();
    recordRevealFrameMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('DEV 下每帧采样一次：一次 60 帧的流式突发 = 60 次 recordRevealFrame', () => {
    vi.stubEnv('DEV', true);

    driveStreamingBurst();

    expect(recordRevealFrameMock).toHaveBeenCalledTimes(TOTAL_FRAMES);
    // 采样口径：每帧都调用，被节流跳过的帧传 0（不是"只在提交时调用"）。
    const committedValues = recordRevealFrameMock.mock.calls.map(([committed]) => committed as number);
    expect(committedValues.filter((value) => value === 0).length).toBeGreaterThan(0);
  });

  it('非 DEV 下推进同样的 60 帧：零采样，且可见长度与 DEV 臂一致', () => {
    vi.stubEnv('DEV', true);
    const revealedInDev = driveStreamingBurst();

    // 第二臂必须从完全相同的初始条件出发：清掉已挂载的实例、复位假时钟，
    // 并复位模块级缓存（`resetRevealHorizonCache` 同时复位全局提交闸门）。
    cleanup();
    installFrameClock();
    resetRevealHorizonCache();
    recordRevealFrameMock.mockClear();

    vi.stubEnv('DEV', false);
    const revealedWithoutDiagnostics = driveStreamingBurst();

    expect(recordRevealFrameMock).not.toHaveBeenCalled();
    // 门控只砍掉诊断采样，不能顺带改掉绘制：两臂的可见长度必须完全一致。
    expect(revealedWithoutDiagnostics).toBe(revealedInDev);
    expect(revealedInDev).toBeGreaterThan(50);
  });
});
