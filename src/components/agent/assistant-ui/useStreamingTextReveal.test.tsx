// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRevealHorizonCache, useStreamingTextReveal } from './useStreamingTextReveal';

/**
 * 这些用例验证的是**提交节流**是否真的生效 —— 它是本轮修复的核心。
 *
 * 为什么值得单独测：分帧绘制把"释放多少字符"算得很便宜，但把它**画上去**要重跑
 * Markdown 分块与 Shiki 分词。若按 rAF 的 60Hz 无节制提交，主线程会被占满，
 * 而 `DotMatrix` 的 SVG `opacity` 与 `.shimmer` 的 `background-clip: text` 都是
 * 绘制类动画、无法卸载到合成线程 —— 结果是**全应用的 loading 动效一起冻住**。
 */

const MIN_FRAME_KEY = 'codemux:textRevealMinFrameMs';

let clock = 0;
let frameQueue: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrameId = 1;
let renderCount = 0;

function installFrameClock(): void {
  // 从一个非 0 的起点开始，避免把"时间戳 0"与"未初始化"混为一谈。
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
  renderCount += 1;
  return <span data-testid="revealed">{revealed.length}</span>;
}

/** 模拟 1 秒的流式：每 50ms 到达 200 字符，每 16ms 一帧。返回"提交"次数。 */
function simulateOneSecond(): number {
  let text = 'x'.repeat(50);
  const { rerender } = render(<Probe text={text} streaming />);

  renderCount = 0;
  let explicitRenders = 0;

  for (let tick = 0; tick < 20; tick += 1) {
    runFrames(3, 16);
    text += 'x'.repeat(200);
    act(() => {
      rerender(<Probe text={text} streaming />);
    });
    explicitRenders += 1;
  }

  return renderCount - explicitRenders;
}

describe('useStreamingTextReveal commit throttling', () => {
  beforeEach(() => {
    installFrameClock();
    window.localStorage.clear();
    resetRevealHorizonCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('bounds commits well below the frame rate', () => {
    const commits = simulateOneSecond();

    // 1 秒 / 40ms ≈ 25 次上限。断言留出余量，但必须显著低于 60 帧。
    expect(commits).toBeGreaterThan(5);
    expect(commits).toBeLessThan(35);
  });

  it('commits on essentially every frame once throttling is disabled', () => {
    window.localStorage.setItem(MIN_FRAME_KEY, '0');
    resetRevealHorizonCache();

    const commits = simulateOneSecond();

    // 同一段流式，不节流时应接近逐帧提交 —— 这条对照正是节流生效的证据。
    expect(commits).toBeGreaterThan(40);
  });

  it('honours a custom cadence', () => {
    window.localStorage.setItem(MIN_FRAME_KEY, '200');
    resetRevealHorizonCache();

    const commits = simulateOneSecond();

    // 1 秒 / 200ms = 5 次上限。
    expect(commits).toBeLessThanOrEqual(8);
  });

  it('still reveals everything after the stream ends', () => {
    let text = 'x'.repeat(50);
    const { rerender, getByTestId } = render(<Probe text={text} streaming />);

    text += 'x'.repeat(500);
    act(() => {
      rerender(<Probe text={text} streaming />);
    });
    runFrames(2, 16);

    // 停止流式时必须立即补全，不能残留半截文字。
    act(() => {
      rerender(<Probe text={text} streaming={false} />);
    });

    expect(getByTestId('revealed').textContent).toBe(String(text.length));
  });

  it('reveals a freshly seen stream in full rather than animating from zero', () => {
    // 挂载时缓冲区里已经有内容（历史补全 / 切回会话 / 虚拟化行重挂载），
    // 必须整段渲染，否则会先闪一段空白。
    const text = 'x'.repeat(800);
    const { getByTestId } = render(<Probe text={text} streaming />);

    expect(getByTestId('revealed').textContent).toBe(String(text.length));
  });
});
