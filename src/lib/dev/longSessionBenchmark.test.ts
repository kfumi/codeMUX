// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  buildLongSessionBenchmark,
  inspectShortSessionBaseline,
  type LongSessionBenchmarkReadings,
} from './longSessionBenchmark';
import {
  LONG_SESSION_BURST_SEED,
  LONG_SESSION_EVENT_THRESHOLD,
  LONG_SESSION_TURN_COUNT,
  SHORT_SESSION_TURN_COUNT,
  longSessionEventCount,
} from './longSessionFixture';
import { THREAD_WINDOW_STEADY_TURNS } from '../threadWindow';

/**
 * markdown 渲染层在 jsdom 里的代价过高（每条文本都要走 remark/rehype 并调用 Shiki），
 * 降级方式照抄 `CodeMuxAssistantRuntime.test.tsx`：className 与文本照常渲染，只剥离
 * 标题/列表前缀与代码围栏。基准测的是线程规模与发布节奏，不是 markdown 解析器。
 */
function toPlainMarkdownBlocks(children: ReactNode): ReactNode {
  if (typeof children !== 'string') {
    return children ?? null;
  }

  return children
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .map((line, index) =>
      createElement(
        'div',
        { key: index },
        line.replace(/^#{1,6}\s+/, '').replace(/^([-*+]|\d+\.)\s+/, '').replace(/^>\s+/, ''),
      ),
    );
}

vi.mock('streamdown', () => ({
  defaultRehypePlugins: {},
  Streamdown: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, toPlainMarkdownBlocks(children)),
}));

vi.mock('@assistant-ui/react-streamdown', async () => {
  const { useMessagePartText } = await import('@assistant-ui/react');

  return {
    StreamdownTextPrimitive: ({ className }: { className?: string }) => {
      const part = useMessagePartText();
      return createElement('div', { className }, toPlainMarkdownBlocks(part.text));
    },
  };
});

vi.mock('@streamdown/code', () => ({
  code: { name: 'stub-code-highlighter', type: 'code-highlighter' },
}));

/**
 * 基准跑完后必须还原到这些原始引用上：不还原就会污染同一文件里后面的用例，
 * 也会让其它文件的 jsdom 环境带上计数包装。
 */
const pristineGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const pristineScrollHeightGetter = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollHeight',
)?.get;
const pristineRequestAnimationFrame = globalThis.requestAnimationFrame;
const pristineDateNow = Date.now;

/** 确定性用例用的轮数：仍然跨过长会话阈值（45 轮 = 180 条事件 > 120），但挂载更快。 */
const DETERMINISM_TURN_COUNT = 45;
const DETERMINISM_STREAM_FRAME_COUNT = 40;
const DETERMINISM_SCROLL_CYCLES = 3;

/** 只打印计数与比值，毫秒观测量单独一行，便于人工核对。 */
function logReadings(label: string, readings: LongSessionBenchmarkReadings): void {
  console.log(`[long-session-benchmark:${label}]`, JSON.stringify(readings.counters, null, 2));
  console.log(`[long-session-benchmark:${label}:observations]`, JSON.stringify(readings.observations));
}

describe('longSessionBenchmark', () => {

  it('同一夹具 + 同一种子跑两次得到完全一致的计数与比值', async () => {
    const first = await buildLongSessionBenchmark({
      turnCount: DETERMINISM_TURN_COUNT,
      seed: LONG_SESSION_BURST_SEED,
      streamFrameCount: DETERMINISM_STREAM_FRAME_COUNT,
      scrollCycles: DETERMINISM_SCROLL_CYCLES,
    });
    const second = await buildLongSessionBenchmark({
      turnCount: DETERMINISM_TURN_COUNT,
      seed: LONG_SESSION_BURST_SEED,
      streamFrameCount: DETERMINISM_STREAM_FRAME_COUNT,
      scrollCycles: DETERMINISM_SCROLL_CYCLES,
    });

    // 深相等：读数必须只由夹具 + 种子 + 假时钟决定。
    expect(second.counters).toEqual(first.counters);
    expect(second.observers).toEqual(first.observers);

    // observations 里是毫秒类观测量，按口径不参与确定性比较：wallClockMs 是唯一的真实时间
    // 量（CI 负载一变就变），后续工单也可能把某一项换成真实时钟口径。
    // 下面单独比对两个间隔分位：它们由假时钟派生，必须相等 —— 既锁住「时钟真的接上了」，
    // 又不让真实时间混进门禁。
    expect(second.observations.visibleUpdateIntervalP50Ms).toBe(
      first.observations.visibleUpdateIntervalP50Ms,
    );
    expect(second.observations.visibleUpdateIntervalP95Ms).toBe(
      first.observations.visibleUpdateIntervalP95Ms,
    );
    expect(first.observations.visibleUpdateIntervalP95Ms).toBeGreaterThan(0);
    expect(first.observations.wallClockMs).toBeGreaterThan(0);

    // 夹具规模与假时钟派生量本身也要有内容，否则「两次都是 0」的深相等毫无意义。
    expect(first.counters.scale.eventCount).toBe(
      longSessionEventCount(DETERMINISM_TURN_COUNT),
    );
    expect(first.counters.mount.componentCommits).toBeGreaterThan(0);
    expect(first.counters.stream.eventsAppended).toBeGreaterThan(0);
    expect(first.counters.nav.layoutReads).toBeGreaterThan(0);
  }, 30_000);

  it('长会话规模跨过阈值，且四个维度的读数都拿得到', async () => {
    const readings = await buildLongSessionBenchmark({
      seed: LONG_SESSION_BURST_SEED,
    });
    logReadings('long-session', readings);

    const { counters } = readings;

    // 规模：200 轮 / 800 条事件，远高于长会话阈值；线程确实带上了长会话路径的属性。
    expect(counters.scale.turnCount).toBe(LONG_SESSION_TURN_COUNT);
    expect(counters.scale.eventCount).toBe(longSessionEventCount(LONG_SESSION_TURN_COUNT));
    expect(counters.scale.eventCount).toBeGreaterThan(LONG_SESSION_EVENT_THRESHOLD);
    expect(counters.scale.isAboveThreshold).toBe(true);

    // 挂载：线程真的画出来了，且带长会话离屏跳过属性。
    expect(counters.mount.longThreadAttribute).toBe(true);
    expect(counters.mount.componentCommits).toBeGreaterThan(0);
    // 窗口契约（工单 03）：挂载行数有界，不再随历史长度线性增长。
    // 200 轮夹具在稳态挂载尾部 30 轮 ≈ 90 行（每轮 3 行），而不是全量的 600 行。
    // 若未来改动使该值重新随 LONG_SESSION_TURN_COUNT 线性增长，这里会失败。
    expect(counters.mount.messageRows).toBeGreaterThan(0);
    expect(counters.mount.messageRows).toBeLessThanOrEqual(THREAD_WINDOW_STEADY_TURNS * 3 + 8);
    expect(counters.mount.messageRows).toBeLessThan(LONG_SESSION_TURN_COUNT * 3);
    expect(counters.mount.domNodes).toBeGreaterThan(counters.mount.messageRows);

    // rewind：期望「events 与 turns 同代」恰好一代，且没有多余的只改 events / 只改 turns 的
    // 发布 —— 这正是长会话回退不再把每条存活行渲染两遍的契约。
    expect(counters.rewind.removedEvents).toBeGreaterThan(0);
    expect(counters.rewind.eventsAndTurnsGenerations).toBe(1);
    expect(counters.rewind.eventsOnlyGenerations).toBe(0);
    expect(counters.rewind.turnsOnlyGenerations).toBe(0);
    expect(counters.rewind.eventsOrTurnsGenerations).toBe(1);
    // 回退会顺带清掉 pendingPermissions 一类状态，因此总发布代数 >= 相关发布代数。
    expect(counters.rewind.allStoreGenerations).toBeGreaterThanOrEqual(
      counters.rewind.eventsOrTurnsGenerations,
    );
    expect(counters.rewind.componentCommits).toBeGreaterThan(0);

    // 流式：每追加一个事件产生两代 store 发布（events 一代 + 订阅者补算 turns 一代）与
    // 至少一次组件 commit；可见更新间隔的 p95/p50 明显大于 1，说明到达节奏确实是突发的。
    expect(counters.stream.scheduledChunks).toBe(counters.stream.eventsAppended);
    expect(counters.stream.eventsAppended).toBeGreaterThan(0);
    // 帧数由基准的默认窗口决定，这里只钉「驱动了多帧、只有一部分帧真的推进」这个关系。
    expect(counters.stream.producedFrames).toBeGreaterThan(counters.stream.eventsAppended);
    expect(counters.stream.advancingFrames).toBe(counters.stream.eventsAppended);
    expect(counters.stream.advancingFrameRatio).toBeGreaterThan(0);
    expect(counters.stream.advancingFrameRatio).toBeLessThan(1);
    expect(counters.stream.storeGenerationsPerAppend).toBe(2);
    expect(counters.stream.componentCommitsPerAppend).toBeGreaterThanOrEqual(1);
    expect(counters.stream.visibleUpdatesPerSecond).toBeGreaterThan(0);
    expect(counters.stream.inboundFrames).toBe(counters.stream.eventsAppended);
    expect(counters.stream.inboundFramesPerSecond).toBeGreaterThan(0);
    expect(counters.stream.inboundFramesPerSecond).toBeLessThanOrEqual(
      counters.stream.inboundFrames,
    );
    expect(counters.stream.updateIntervalSpreadRatio).toBeGreaterThan(1);

    // 导航：工单 02 的靶子。jsdom 不做布局，所以这段成本只能用调用次数钉住。
    // 契约：滚动突发期间**不得逐项测量**。改动前这里是每帧 1 次容器测量 + 每个
    // 用户导航项各一次（= 1 + 轮数 - 1，实测 1600 次）；把当时的数字固定下来
    // 等于把回归钉死在测试里，所以这里断言的是不变量而不是某次读数。
    expect(counters.nav.scrollEvents).toBe(counters.nav.flushedFrames * 2);
    expect(counters.nav.layoutReadsByProperty.getBoundingClientRect ?? 0).toBe(0);
    // 与导航项数解耦：每帧的布局读取次数必须落在与项数无关的量级。
    // （改动前该值是每帧 200 次，即 1 次容器 + 199 个导航项。）
    expect(counters.nav.layoutReadsPerFlushedFrame).toBeLessThan(LONG_SESSION_TURN_COUNT);
    // 除逐项测量之外，每次滚动事件与每帧还要读 scrollHeight/clientHeight
    // （钉底判定、内容变化判定）—— 这部分是允许的增量。
    expect(counters.nav.layoutReadsByProperty.scrollHeight).toBeGreaterThan(
      counters.nav.scrollEvents,
    );
    expect(counters.nav.layoutReadsByProperty.clientHeight).toBeGreaterThan(0);

    expect(readings.observers).toEqual({
      storeGenerations: true,
      layoutReads: true,
      frameClock: true,
      perfStoreIpc: true,
    });
    // 预算放宽到 90s：这条用例实测在 13.1s–33.4s 之间随机器负载波动（本轮改动前
    // 曾撞到 30s 上限并连累后面的清理用例），30s 太紧会变成负载型假失败。
  }, 90_000);

  it('短会话不进入新增度量路径，也不产出基准读数', async () => {
    const baseline = inspectShortSessionBaseline();
    console.log('[long-session-benchmark:short-session]', JSON.stringify(baseline));

    expect(baseline.turnCount).toBe(SHORT_SESSION_TURN_COUNT);
    expect(baseline.eventCount).toBe(longSessionEventCount(SHORT_SESSION_TURN_COUNT));
    expect(baseline.eventCount).toBeLessThanOrEqual(LONG_SESSION_EVENT_THRESHOLD);

    // 没有基准读数，也没有装上任何观察者。
    expect(baseline.readings).toBeNull();
    expect(baseline.observers).toEqual({
      storeGenerations: false,
      layoutReads: false,
      frameClock: false,
      perfStoreIpc: false,
    });

    // 行为与现状一致：照常挂载出行，但不带长会话离屏跳过属性。
    expect(baseline.longThreadAttribute).toBe(false);
    expect(baseline.messageRows).toBeGreaterThan(0);
    expect(baseline.messageRows).toBeLessThan(LONG_SESSION_EVENT_THRESHOLD);
    expect(baseline.domNodes).toBeGreaterThan(baseline.messageRows);
    expect(baseline.mountComponentCommits).toBeGreaterThan(0);
  });

  it('低于阈值时拒绝采集长会话读数', async () => {
    await expect(
      buildLongSessionBenchmark({ turnCount: SHORT_SESSION_TURN_COUNT }),
    ).rejects.toThrow(/inspectShortSessionBaseline/);
  });

  it('跑完之后不留观察者：几何读取、帧钟与 Date.now 都还原', () => {
    expect(Element.prototype.getBoundingClientRect).toBe(pristineGetBoundingClientRect);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')?.get).toBe(
      pristineScrollHeightGetter,
    );
    expect(globalThis.requestAnimationFrame).toBe(pristineRequestAnimationFrame);
    expect(Date.now).toBe(pristineDateNow);
  });
});
