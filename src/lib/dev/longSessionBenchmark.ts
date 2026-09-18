/**
 * 长会话基准 —— 让「长会话性能」从手感变成可复现、可断言的读数。
 *
 * 缺口：本仓库此前四轮流式性能修复都没有端到端实测，改动前后无法回答「到底哪一项起了
 * 作用」。这里把「一次长会话的挂载 / 回退 / 流式 / 滚动」压成一组**计数与比值**，后续
 * 工单（02 导航每帧成本、03 尾部挂载窗口）只需改动前后各跑一次即可对比，不必再动夹具。
 *
 * ## 三条口径
 *
 * 1. **CI 安全**：读数全部走 store 与共享夹具的公开入口，不经过任何 `import.meta.env.DEV`
 *    门控的浮层采集点 —— 那些采集点在生产构建里会被整段剔除，基准不能建在它们上面。
 * 2. **确定性**：时钟可注入。帧钟、定时器与 `Date.now` 在基准运行期间全部换成假时钟，
 *    所以「同一夹具 + 同一种子跑两次」必须逐字段深相等。
 * 3. **毫秒只作观测量**：jsdom 不实现布局，真实耗时随 CI 负载抖动。能作为门禁的只有
 *    计数与比值；毫秒类数值单独放在 `observations` 里，不参与确定性断言。
 *
 * ## 各读数的定义
 *
 * - 挂载：被测子树的 React commit 次数（`<Profiler>`）、`[data-message-row]` 行数、
 *   容器内 DOM 节点总数、是否带上长会话离屏阈值属性（生产侧 `data-long-thread`）。
 * - rewind：调用 store 的回退动作，记 store 发布代数，并区分「只改 events」「events+turns
 *   同代」「只改 turns」，以及该过程的组件 commit 次数。这三者的分布正是长会话回退变卡
 *   的那个量：turns 被单独发布一代，会让每条存活行多渲染一次。
 * - 流式：用固定种子的突流驱动一段到达节奏（每次到达追加一个事件），记每追加一个事件
 *   产生的 store 发布代数与组件 commit 次数、可见更新间隔分位、推进帧占比、每秒可见更新
 *   数与入站帧速率（走 perfStore）。
 * - 导航：一次模拟滚动突发里的**布局读取调用次数**。jsdom 不做布局，「每帧读多少次几何」
 *   只能用调用计数来断言 —— 这正是工单 02 要压下去的指标。
 */

import { Profiler, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { CodeMuxAssistantRuntimeProvider } from '../../components/agent/assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from '../../components/agent/assistant-ui/CodeMuxThread';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { usePerfStore } from '../../stores/perfStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types/session';
import { daemonFacade } from '../facades/daemon-facade';
import { readAndResetSmoothness, recordRevealFrame, resetSmoothness } from '../streamSmoothness';
import { createBurstyStreamSchedule, pumpBurstySchedule } from './burstyStreamSchedule';
import {
  LONG_SESSION_BURST_SEED,
  LONG_SESSION_EVENT_THRESHOLD,
  LONG_SESSION_ID,
  LONG_SESSION_TURN_COUNT,
  SHORT_SESSION_TURN_COUNT,
  buildLongSessionEvents,
  longSessionEventCount,
  userMessageEventIndex,
} from './longSessionFixture';

// ── 读数类型 ────────────────────────────────────────────────────────────────

export interface LongSessionScaleCounters {
  sessionId: string;
  turnCount: number;
  eventCount: number;
  longSessionEventThreshold: number;
  /** 夹具规模是否真的跨过长会话阈值（生产侧离屏跳过、导航条等都按这个量级分岔）。 */
  isAboveThreshold: boolean;
}

export interface LongSessionMountCounters {
  /** 挂载期间被测子树的 commit 次数。 */
  componentCommits: number;
  /** DOM 里的消息行数（`[data-message-row]`）。 */
  messageRows: number;
  /** 容器内 DOM 节点总数（不含容器自身）。 */
  domNodes: number;
  /** 线程是否带上长会话离屏跳过属性。 */
  longThreadAttribute: boolean;
}

export interface LongSessionRewindCounters {
  /** 被回退掉的事件数。 */
  removedEvents: number;
  /** 被回退掉的 DOM 行数。 */
  removedRows: number;
  /** 该步骤内 store 的全部发布代数。 */
  allStoreGenerations: number;
  /** 其中 events 或 turns 发生变化的代数。 */
  eventsOrTurnsGenerations: number;
  /** 「只改 events」的代数 —— 会紧跟着多出一次仅 turns 的发布，让存活行渲染两遍。 */
  eventsOnlyGenerations: number;
  /** 「events 与 turns 同代」的代数 —— 期望值：1。 */
  eventsAndTurnsGenerations: number;
  /** 「只改 turns」的代数。 */
  turnsOnlyGenerations: number;
  componentCommits: number;
}

export interface LongSessionStreamCounters {
  /** 到达批次总数（排程在被驱动的窗口内产出的批次）。 */
  scheduledChunks: number;
  /** 每次到达追加一个事件，因此等于被处理的事件数。 */
  eventsAppended: number;
  /** 被驱动的帧数（= 绘制层上报的帧数）。 */
  producedFrames: number;
  /** 真正提交了可见更新的帧数。 */
  advancingFrames: number;
  /** 推进帧占比：越接近 1 越是「来得均匀」，越小说明大部分帧空转。 */
  advancingFrameRatio: number;
  storeGenerations: number;
  storeGenerationsPerAppend: number;
  componentCommits: number;
  componentCommitsPerAppend: number;
  visibleUpdates: number;
  visibleUpdatesPerSecond: number;
  /** 入站帧速率：perfStore 的 1s 窗口计数（假时钟下确定）。 */
  inboundFrames: number;
  inboundFramesPerSecond: number;
  /** p95 间隔 / p50 间隔：无单位，跨时钟可比，是「一跳一跳」的直接度量。 */
  updateIntervalSpreadRatio: number;
}

export interface LongSessionNavCounters {
  scrollEvents: number;
  flushedFrames: number;
  componentCommits: number;
  /** 布局读取总次数（`getBoundingClientRect` 与几何 getter 之和）。 */
  layoutReads: number;
  layoutReadsPerScrollEvent: number;
  layoutReadsPerFlushedFrame: number;
  /** 按属性拆分的调用次数：工单 02 的靶子是 `getBoundingClientRect`。 */
  layoutReadsByProperty: Record<string, number>;
}

/** 计数与比值读数：全部由夹具与假时钟派生，必须逐次可复现，参与深相等断言。 */
export interface LongSessionBenchmarkCounters {
  scale: LongSessionScaleCounters;
  mount: LongSessionMountCounters;
  rewind: LongSessionRewindCounters;
  stream: LongSessionStreamCounters;
  nav: LongSessionNavCounters;
}

/**
 * 毫秒类观测量：只作观测量，**不参与门禁断言**。
 *
 * 原因是它们在真实浏览器里会随 CI 负载抖动，而基准的第一要求是确定性；假时钟当下虽然
 * 让它们也可复现，但后续工单完全可能把某一项换成真实时钟口径，门禁不能因此变红。
 */
export interface LongSessionBenchmarkObservations {
  /** 流式窗口在假时钟上走过的毫秒数。 */
  streamClockSpanMs: number;
  /** 可见更新间隔分位（假时钟派生）。 */
  visibleUpdateIntervalP50Ms: number;
  visibleUpdateIntervalP95Ms: number;
  /** 本次运行的真实墙钟耗时 —— 唯一的真实时间量，只为判断 CI 预算。 */
  wallClockMs: number;
}

/** 基准自己装上的观察者。短会话基线要求四项全为 false。 */
export interface BenchmarkObserverFlags {
  storeGenerations: boolean;
  layoutReads: boolean;
  frameClock: boolean;
  perfStoreIpc: boolean;
}

export interface LongSessionBenchmarkReadings {
  counters: LongSessionBenchmarkCounters;
  observations: LongSessionBenchmarkObservations;
  observers: BenchmarkObserverFlags;
}

export interface LongSessionBenchmarkOptions {
  /** 轮数。默认夹具的 200 轮；只要事件数跨过阈值就仍走长会话路径。 */
  turnCount?: number;
  /** 突流种子。默认夹具里那个固定种子。 */
  seed?: number;
  /** 流式窗口的帧数（每帧 16ms 假时间）。 */
  streamFrameCount?: number;
  /**
   * 导航突发里的「帧 + 两帧之间的滚动事件」周期数。
   * 每个周期派发 {@link SCROLL_EVENTS_PER_FRAME} 次滚动事件再推进一帧，
   * 这样「每次滚动」与「每帧」两个口径都能读到不同的数。
   */
  scrollCycles?: number;
}

/** 短会话基线：不装任何观察者、不产出基准读数。 */
export interface ShortSessionBaseline {
  turnCount: number;
  eventCount: number;
  /** 短会话不产出基准读数。 */
  readings: null;
  observers: BenchmarkObserverFlags;
  messageRows: number;
  domNodes: number;
  longThreadAttribute: boolean;
  mountComponentCommits: number;
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 假帧钟的帧间隔，与 60Hz 同量级。 */
const FRAME_MS = 16;
/** 假时钟起点：从非 0 开始，避免把「时间戳 0」与「未初始化」混为一谈。 */
const CLOCK_START_MS = 1_000;
/** 流式窗口默认帧数（72 帧 ≈ 1.15s 假时间，够跑出突发的空闲间隔）。 */
const DEFAULT_STREAM_FRAME_COUNT = 72;
/** 导航突发默认周期数。 */
const DEFAULT_SCROLL_CYCLES = 8;
/** 每个周期里先派发几次滚动事件，再推进一帧。 */
const SCROLL_EVENTS_PER_FRAME = 2;
/** 每次滚动向上走的像素数：模拟「回看历史」，此时 follow-latest 会主动让出滚动控制权。 */
const SCROLL_STEP_PX = 40;
/** 视口初始滚动位置：远离底部，使 `scrollHeight/clientHeight` 分支走到真实分支。 */
const VIEWPORT_INITIAL_SCROLL_TOP = 500;

/**
 * jsdom 不做布局，`scrollHeight/clientHeight` 恒为 0。给被测视口一组确定性几何，
 * 让依赖这两个值的分支（钉底判定、内容变化判定）走到真实分支而不是恒真的退化分支。
 */
const VIEWPORT_GEOMETRY = { scrollHeight: 1_000, clientHeight: 256 } as const;

/** 入站帧在 perfStore 里记的命令名。 */
const INBOUND_COMMAND = 'stream.inbound';

/** Profiler 的 id：只用于在 React DevTools 里认出这次基准的提交。 */
const BENCHMARK_PROFILER_ID = 'codemux-long-session-benchmark';

/** 基准不发送也不执行命令：线程只负责渲染历史。 */
const noopSend = async (): Promise<void> => {};
const noopCommand = async (): Promise<void> => {};

/** 被计数几何读取的属性。前 8 个是 getter，最后一个（`getBoundingClientRect`）是方法。 */
const LAYOUT_GETTER_PROPERTIES = [
  'scrollHeight',
  'scrollWidth',
  'clientHeight',
  'clientWidth',
  'offsetHeight',
  'offsetWidth',
  'offsetTop',
  'offsetLeft',
] as const;

const BOUNDING_RECT_PROPERTY = 'getBoundingClientRect';

const NO_OBSERVERS: BenchmarkObserverFlags = {
  storeGenerations: false,
  layoutReads: false,
  frameClock: false,
  perfStoreIpc: false,
};

// ── 假帧钟 ──────────────────────────────────────────────────────────────────

interface TimerEntry {
  id: number;
  dueAt: number;
  callback: () => void;
}

interface FrameClock {
  now: () => number;
  /** 交给 `pumpBurstySchedule` 的排程函数：排进假定时器队列，不碰真实 setTimeout。 */
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
  /** 推进一帧：先跑到期批次，再执行上一帧排入的 rAF 回调。 */
  advanceFrame: () => void;
  /** 空转若干帧，把上一步遗留的排帧（历史补全钉底等）结算掉。 */
  settle: (maxFrames?: number) => void;
  uninstall: () => void;
}

/**
 * 装上假帧钟：接管 `requestAnimationFrame`/`cancelAnimationFrame`，并给出可注入的
 * 定时器与时钟。真实 rAF 与真实 `performance.now` 会随负载抖动，无法用于确定性断言。
 */
function installFrameClock(): FrameClock {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  let clock = CLOCK_START_MS;
  let nextId = 1;
  let frameQueue: Array<{ id: number; callback: FrameRequestCallback }> = [];
  const timers: TimerEntry[] = [];

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextId;
    nextId += 1;
    frameQueue.push({ id, callback });
    return id;
  };
  globalThis.cancelAnimationFrame = (handle: number): void => {
    frameQueue = frameQueue.filter((entry) => entry.id !== handle);
  };

  const now = (): number => clock;

  const setTimer = (callback: () => void, delayMs: number): number => {
    const id = nextId;
    nextId += 1;
    timers.push({ id, dueAt: clock + Math.max(0, delayMs), callback });
    return id;
  };

  const clearTimer = (handle: number): void => {
    const index = timers.findIndex((entry) => entry.id === handle);
    if (index >= 0) {
      timers.splice(index, 1);
    }
  };

  const runDueTimers = (): void => {
    // 定时器回调可能排新的定时器：按到期时间逐个取出，直到没有到期的为止。
    for (let guard = 0; guard < 100_000; guard += 1) {
      let next: TimerEntry | null = null;
      for (const entry of timers) {
        if (entry.dueAt <= clock && (next === null || entry.dueAt < next.dueAt)) {
          next = entry;
        }
      }
      if (next === null) {
        return;
      }
      timers.splice(timers.indexOf(next), 1);
      next.callback();
    }
    throw new Error('长会话基准：假定时器没有收敛');
  };

  /** 只跑「本帧之前已排入」的回调，与真实 rAF 语义一致（本帧新排的留到下一帧）。 */
  const flushFrames = (): void => {
    const pending = frameQueue;
    frameQueue = [];
    if (pending.length === 0) {
      return;
    }
    act(() => {
      for (const entry of pending) {
        entry.callback(clock);
      }
    });
  };

  const advanceFrame = (): void => {
    clock += FRAME_MS;
    runDueTimers();
    flushFrames();
  };

  return {
    now,
    setTimer,
    clearTimer,
    advanceFrame,
    settle: (maxFrames = 4) => {
      for (let index = 0; index < maxFrames; index += 1) {
        if (frameQueue.length === 0) {
          return;
        }
        advanceFrame();
      }
    },
    uninstall: () => {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      frameQueue = [];
      timers.length = 0;
    },
  };
}

// ── 几何读取计数器 ──────────────────────────────────────────────────────────

export interface LayoutGeometryOverride {
  element: Element;
  scrollHeight?: number;
  clientHeight?: number;
}

export interface LayoutReadCounter {
  read: () => { total: number; byProperty: Record<string, number> };
  /** 丢弃热身读数（把被测对象推到稳定状态的那几次读取不该计入）。 */
  reset: () => void;
  uninstall: () => void;
}

function findPrototypeWithGetter(
  prototypes: readonly object[],
  property: string,
): object | null {
  for (const prototype of prototypes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.get && descriptor.configurable) {
      return prototype;
    }
  }
  return null;
}

/**
 * 计数布局读取调用。jsdom 里所有几何都是 0、也不存在强制同步布局，所以「每帧读多少次
 * 几何」只能用调用次数来断言 —— 这正是工单 02 的靶子。
 *
 * 可选地提供几何覆盖：被测元素（视口）返回确定性的 `scrollHeight/clientHeight`，
 * 使依赖它们的生产分支不落进「两个 0 都比较相等」的退化路径。
 */
export function installLayoutReadCounter(
  geometryOverrides: readonly LayoutGeometryOverride[] = [],
): LayoutReadCounter {
  const counts: Record<string, number> = {};
  const restores: Array<() => void> = [];

  const bump = (property: string): void => {
    counts[property] = (counts[property] ?? 0) + 1;
  };

  const overrideFor = (element: Element, property: string): number | undefined => {
    for (const override of geometryOverrides) {
      if (override.element !== element) {
        continue;
      }
      if (property === 'scrollHeight' && override.scrollHeight !== undefined) {
        return override.scrollHeight;
      }
      if (property === 'clientHeight' && override.clientHeight !== undefined) {
        return override.clientHeight;
      }
    }
    return undefined;
  };

  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    bump(BOUNDING_RECT_PROPERTY);
    return originalGetBoundingClientRect.call(this);
  };
  restores.push(() => {
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  for (const property of LAYOUT_GETTER_PROPERTIES) {
    // 属性分布在不同原型层上：scrollHeight 在 Element，offsetHeight 在 HTMLElement。
    const owner = findPrototypeWithGetter([Element.prototype, HTMLElement.prototype], property);
    if (!owner) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    const originalGet = descriptor?.get;
    if (!originalGet) {
      continue;
    }
    Object.defineProperty(owner, property, {
      configurable: true,
      get(this: Element): number {
        bump(property);
        const override = overrideFor(this, property);
        return override !== undefined ? override : (originalGet.call(this) as number);
      },
    });
    restores.push(() => {
      Object.defineProperty(owner, property, descriptor as PropertyDescriptor);
    });
  }

  return {
    read: () => ({
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      byProperty: { ...counts },
    }),
    reset: () => {
      for (const key of Object.keys(counts)) {
        delete counts[key];
      }
    },
    uninstall: () => {
      for (const restore of restores.reverse()) {
        restore();
      }
    },
  };
}

// ── store 发布代计数器 ──────────────────────────────────────────────────────

interface AgentStoreGenerationCounts {
  all: number;
  eventsOrTurns: number;
  eventsOnly: number;
  eventsAndTurns: number;
  turnsOnly: number;
}

interface AgentStoreGenerationCounter {
  read: () => AgentStoreGenerationCounts;
  uninstall: () => void;
}

/**
 * 记录每次 store 发布影响了哪些字段，沿用 `agentStore.test.ts` 里那条发布代断言的手法。
 * `/rewind` 的靶子是：「events+turns 同代」必须是 1，且不能出现「只改 turns」的多余一代。
 */
function installAgentStoreGenerationCounter(sessionId: string): AgentStoreGenerationCounter {
  const counts: AgentStoreGenerationCounts = {
    all: 0,
    eventsOrTurns: 0,
    eventsOnly: 0,
    eventsAndTurns: 0,
    turnsOnly: 0,
  };

  const unsubscribe = useAgentStore.subscribe((state, previous) => {
    counts.all += 1;
    const eventsChanged = state.events[sessionId] !== previous.events[sessionId];
    const turnsChanged = state.turns[sessionId] !== previous.turns[sessionId];

    if (!eventsChanged && !turnsChanged) {
      return;
    }
    counts.eventsOrTurns += 1;
    if (eventsChanged && turnsChanged) {
      counts.eventsAndTurns += 1;
    } else if (eventsChanged) {
      counts.eventsOnly += 1;
    } else {
      counts.turnsOnly += 1;
    }
  });

  return { read: () => ({ ...counts }), uninstall: unsubscribe };
}

// ── 夹具装配与挂载 ──────────────────────────────────────────────────────────

function primeSessionStore(sessionId: string): void {
  const session: Session = {
    id: sessionId,
    title: '长会话基准',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    permission_config: null,
    plan_mode: null,
    project_id: null,
    origin: 'native',
    is_read_only: false,
    created_at: '',
    updated_at: '',
    is_archived: false,
    is_pinned: false,
  };
  useSessionStore.setState({
    sessions: [session],
    archivedSessions: [],
    activeSessionId: sessionId,
    isLoading: false,
    error: null,
  });
}

/**
 * 预置 store。每次都整份覆盖夹具，使同一文件里跑两次的起点完全相同（确定性前提之一）。
 */
function primeAgentStore(sessionId: string, events: AgentMessage[]): void {
  useAgentStore.setState((state) => ({
    events: { ...state.events, [sessionId]: events },
    eventTimestamps: {
      ...state.eventTimestamps,
      [sessionId]: events.map((_, index) => index + 1),
    },
    isRunning: { ...state.isRunning, [sessionId]: false },
    forceStopped: { ...state.forceStopped, [sessionId]: false },
    // 没有流式缓冲区，`useStreamingTextReveal` 的常驻帧循环就不会启动 —— 它用的是真实
    // rAF 与真实 performance.now，与本基准的假时钟不同源。
    streamingText: { ...state.streamingText, [sessionId]: '' },
    streamingThinking: { ...state.streamingThinking, [sessionId]: '' },
  }));
}

/**
 * jsdom 的两个缺口：`ResizeObserver` 不存在，`HTMLElement.prototype.scrollTo` 没有实现。
 * 这两处都是环境缺口而不是被测行为，因此在基准里补齐（退出时还原），
 * 让后续工单不必各自再抄一遍。
 */
function installJsdomShims(): () => void {
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  // 观察者回调在基准里不需要被触发：导航条的显隐只依赖视口宽度，jsdom 下宽度为 0 →
  // 导航条照常渲染，正是长会话路径需要的分支。
  class MockResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;

  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  if (!originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }

  return () => {
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
    }
    if (!originalScrollTo) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
    }
  };
}

interface MountedTree {
  container: HTMLDivElement;
  unmount: () => void;
}

/**
 * 挂载线程。挂载方式照抄 `CodeMuxAssistantRuntime.test.tsx`：TooltipProvider +
 * CodeMuxAssistantRuntimeProvider + CodeMuxThread（markdown 渲染层的降级 mock 由调用方
 * 的测试文件提供，真实 markdown 在 jsdom 里代价过高）。
 *
 * `<Profiler>` 包在最外层，用它统计整个子树的 commit 次数 —— 计数在 React commit 阶段
 * 同步回调，因此与假时钟无关。
 */
function mountThread(
  sessionId: string,
  onCommit: () => void,
): MountedTree {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(
        Profiler,
        { id: BENCHMARK_PROFILER_ID, onRender: onCommit },
        // 两个 Provider 的 props 类型把 children 声明成必填，因此 children 只能从 props
        // 里传（`createElement` 的变参 overload 不接受带 children 的 props 类型）。
        createElement(TooltipProvider, {
          children: createElement(CodeMuxAssistantRuntimeProvider, {
            sessionId,
            onSend: noopSend,
            onCommand: noopCommand,
            children: createElement(CodeMuxThread, { sessionId }),
          }),
        }),
      ),
    );
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function countMessageRows(container: HTMLElement): number {
  return container.querySelectorAll('[data-message-row]').length;
}

function hasLongThreadAttribute(container: HTMLElement): boolean {
  const shell = container.querySelector('[data-testid="thread-content-shell"]');
  return shell?.hasAttribute('data-long-thread') ?? false;
}

/** 每次到达追加一个事件：形状与 `CodeMuxAssistantRuntime.test.tsx` 里的长历史增补一致。 */
function appendStreamEvent(sessionId: string, index: number): void {
  const progressEvent: AgentMessage = {
    kind: 'raw',
    data: {
      type: 'tool_progress',
      tool_use_id: `perf-tool-${index % 4}`,
      elapsed_time_seconds: 1,
    },
  } as AgentMessage;

  useAgentStore.setState((state) => {
    const current = state.events[sessionId] ?? [];
    return {
      events: { ...state.events, [sessionId]: [...current, progressEvent] },
      eventTimestamps: {
        ...state.eventTimestamps,
        [sessionId]: [...(state.eventTimestamps[sessionId] ?? []), current.length + 1],
      },
    };
  });
}

// ── 各步骤 ──────────────────────────────────────────────────────────────────
/**
 * 排空落在外面的异步补提交。
 *
 * store 发布一代不等于 DOM 已经更新：assistant-ui 的消息树还有一次由微任务驱动的二次
 * 提交（`useExternalStoreRuntime` 换 adapter 后重建消息）。步骤边界必须把这次补提交一起
 * 吃掉，否则「回退后还剩多少行」「回退产生几次 commit」这类读数会随微提交落在哪一次
 * act 里而在两次运行之间分叉。
 */
async function drainPendingWork(): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 一个步骤拿到的上下文：被测会话、挂载容器、假帧钟与 Profiler 累计提交数。 */
interface StepContext {
  sessionId: string;
  container: HTMLDivElement;
  clock: FrameClock;
  commits: { total: number };
}

/**
 * 回退一步：走 store 的回退动作，统计它产生了多少代 store 发布、这些代分别改了哪些字段、
 * 以及这一步里组件提交了几次。IPC 已在入口处换成确定性的空实现。
 */
async function runRewindStep(
  context: StepContext,
  targetTurn: number,
): Promise<LongSessionRewindCounters> {
  const { sessionId, container, clock, commits } = context;
  const counter = installAgentStoreGenerationCounter(sessionId);
  const eventsBefore = useAgentStore.getState().events[sessionId]?.length ?? 0;
  const rowsBefore = countMessageRows(container);
  const commitsBefore = commits.total;

  try {
    await act(async () => {
      await useAgentStore
        .getState()
        .rewindToMessage(sessionId, userMessageEventIndex(targetTurn), 'conversation');
    });
  } finally {
    counter.uninstall();
  }
  await drainPendingWork();
  clock.settle();

  const generations = counter.read();
  const eventsAfter = useAgentStore.getState().events[sessionId]?.length ?? 0;

  return {
    removedEvents: eventsBefore - eventsAfter,
    removedRows: rowsBefore - countMessageRows(container),
    allStoreGenerations: generations.all,
    eventsOrTurnsGenerations: generations.eventsOrTurns,
    eventsOnlyGenerations: generations.eventsOnly,
    eventsAndTurnsGenerations: generations.eventsAndTurns,
    turnsOnlyGenerations: generations.turnsOnly,
    componentCommits: commits.total - commitsBefore,
  };
}

interface StreamStepResult {
  counters: LongSessionStreamCounters;
  /** 可见更新间隔分位：毫秒，只作观测量。 */
  intervalP50Ms: number;
  intervalP95Ms: number;
}

/**
 * 流式一段：固定种子的突流决定「什么时候到了多少字符」，每个到达批次追加一个事件，
 * 每帧按绘制层的契约上报一次可见更新（没内容可提交时传 0）。
 *
 * 为什么不用生产的 `useStreamingTextReveal` 驱动：它绑死真实 rAF 与真实 `performance.now`，
 * 读数会随负载抖动。这里直接喂 `recordRevealFrame`，走的是同一个平滑度统计口径。
 */
function runStreamStep(
  context: StepContext,
  options: { seed: number; frameCount: number },
): StreamStepResult {
  const { sessionId, clock, commits } = context;
  const { seed, frameCount } = options;

  resetSmoothness();
  usePerfStore.getState().reset();
  const generations = installAgentStoreGenerationCounter(sessionId);
  const originalDateNow = Date.now;
  const commitsBefore = commits.total;
  let scheduledChunks = 0;
  let eventsAppended = 0;
  let pendingChars = 0;

  // perfStore 的 1s 窗口用 Date.now()：换成假时钟，入站帧速率才不会随 CI 负载抖动。
  Date.now = () => clock.now();

  try {
    const schedule = createBurstyStreamSchedule({
      seed,
      totalMs: frameCount * FRAME_MS + FRAME_MS * 4,
    });
    const cancelPump = pumpBurstySchedule(
      schedule,
      (text) => {
        scheduledChunks += 1;
        pendingChars += text.length;
      },
      { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    );

    try {
      for (let frame = 0; frame < frameCount; frame += 1) {
        clock.advanceFrame();
        const chars = pendingChars;
        pendingChars = 0;

        if (chars > 0) {
          act(() => {
            appendStreamEvent(sessionId, eventsAppended);
            usePerfStore.getState().recordIpc(INBOUND_COMMAND, 0, false);
          });
          eventsAppended += 1;
        }

        // 与绘制层同一口径：每帧上报一次，没有内容可提交时传 0。
        recordRevealFrame(chars, clock.now());
      }
    } finally {
      cancelPump();
    }

    const smoothness = readAndResetSmoothness(clock.now());
    const inboundFramesPerSecond = usePerfStore.getState().getIpcRateNow();
    const generationCounts = generations.read();

    return {
      counters: {
        scheduledChunks,
        eventsAppended,
        producedFrames: smoothness.sampledFrames,
        advancingFrames: smoothness.visibleUpdates,
        advancingFrameRatio:
          smoothness.sampledFrames === 0
            ? 0
            : smoothness.visibleUpdates / smoothness.sampledFrames,
        storeGenerations: generationCounts.eventsOrTurns,
        storeGenerationsPerAppend:
          eventsAppended === 0 ? 0 : generationCounts.eventsOrTurns / eventsAppended,
        componentCommits: commits.total - commitsBefore,
        componentCommitsPerAppend:
          eventsAppended === 0 ? 0 : (commits.total - commitsBefore) / eventsAppended,
        visibleUpdates: smoothness.visibleUpdates,
        visibleUpdatesPerSecond: smoothness.updatesPerSecond,
        inboundFrames: eventsAppended,
        inboundFramesPerSecond,
        updateIntervalSpreadRatio:
          smoothness.updateIntervalP50 === 0
            ? 0
            : smoothness.updateIntervalP95 / smoothness.updateIntervalP50,
      },
      intervalP50Ms: smoothness.updateIntervalP50,
      intervalP95Ms: smoothness.updateIntervalP95,
    };
  } finally {
    Date.now = originalDateNow;
    generations.uninstall();
  }
}

/**
 * 导航突发：连续派发滚动事件并逐帧推进，统计这一段的布局读取调用次数。
 * 每次滚动事件与每一帧都会让生产代码去读几何（导航条的「当前项」判定、follow-latest
 * 的钉底判定），jsdom 里这两个成本合起来只能用调用计数表达。
 */
function runNavStep(
  context: StepContext,
  cycles: number,
): LongSessionNavCounters {
  const { container, clock, commits } = context;
  const viewport = container.querySelector<HTMLElement>('[data-testid="thread-viewport"]');
  if (!viewport) {
    throw new Error('长会话基准：找不到 [data-testid="thread-viewport"]，无法模拟滚动突发');
  }

  const counter = installLayoutReadCounter([
    { element: viewport, ...VIEWPORT_GEOMETRY },
  ]);

  try {
    // 热身：把视口推到「已滚到中部」的稳定状态，并结算上一步遗留的排帧，
    // 免得把状态翻转的 commit 与钉底帧算成滚动成本。
    viewport.scrollTop = VIEWPORT_INITIAL_SCROLL_TOP;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
    clock.settle();
    counter.reset();

    const commitsBefore = commits.total;
    let scrollEvents = 0;

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let eventIndex = 0; eventIndex < SCROLL_EVENTS_PER_FRAME; eventIndex += 1) {
        viewport.scrollTop = Math.max(0, viewport.scrollTop - SCROLL_STEP_PX);
        act(() => {
          viewport.dispatchEvent(new Event('scroll'));
        });
        scrollEvents += 1;
      }
      clock.advanceFrame();
    }

    const reads = counter.read();
    const flushedFrames = cycles;

    return {
      scrollEvents,
      flushedFrames,
      componentCommits: commits.total - commitsBefore,
      layoutReads: reads.total,
      layoutReadsPerScrollEvent: reads.total / scrollEvents,
      layoutReadsPerFlushedFrame: reads.total / flushedFrames,
      layoutReadsByProperty: reads.byProperty,
    };
  } finally {
    counter.uninstall();
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function readActEnvironment(): boolean | undefined {
  return (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
}

function setActEnvironment(value: boolean | undefined): void {
  const holder = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  if (value === undefined) {
    delete holder.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  holder.IS_REACT_ACT_ENVIRONMENT = value;
}

/**
 * 同步入口（短会话基线）用：置上 act 环境标记并还原。
 *
 * 异步入口不能用这个包装器：`return run()` 拿到的 promise 还没 await 完，finally 就已经
 * 还原标记了，之后的 act 全都在「没配置 act 环境」下跑 —— React 不再同步冲刷，读数随
 * 调度抖动（这正是第一版的确定性用例抓到的 bug）。
 */
function withActEnvironment<T>(run: () => T): T {
  const previous = readActEnvironment();
  setActEnvironment(true);
  try {
    return run();
  } finally {
    setActEnvironment(previous);
  }
}

/**
 * 跑一次长会话基准。
 *
 * 只对跨过长会话阈值的夹具成立：低于阈值时直接抛错（`inspectShortSessionBaseline` 是
 * 那条路径的入口），防止把短会话的读数当成短会话性能对比的基线。
 *
 * 调用方必须已经在测试文件里 mock 掉 markdown 渲染层（`streamdown` 与
 * `@assistant-ui/react-streamdown`），否则挂载代价会吃掉整个超时预算。
 */
export async function buildLongSessionBenchmark(
  options: LongSessionBenchmarkOptions = {},
): Promise<LongSessionBenchmarkReadings> {
  const turnCount = options.turnCount ?? LONG_SESSION_TURN_COUNT;
  const seed = options.seed ?? LONG_SESSION_BURST_SEED;
  const streamFrameCount = options.streamFrameCount ?? DEFAULT_STREAM_FRAME_COUNT;
  const scrollCycles = options.scrollCycles ?? DEFAULT_SCROLL_CYCLES;
  const eventCount = longSessionEventCount(turnCount);

  if (eventCount <= LONG_SESSION_EVENT_THRESHOLD) {
    throw new Error(
      `长会话基准只对超过 ${LONG_SESSION_EVENT_THRESHOLD} 条事件的会话采集读数，`
      + `${turnCount} 轮只有 ${eventCount} 条；短会话请用 inspectShortSessionBaseline()`,
    );
  }

  const wallClockStartedAt = Date.now();
  const sessionId = LONG_SESSION_ID;
  const events = buildLongSessionEvents(turnCount);
  const commits = { total: 0 };
  const clock = installFrameClock();
  const restoreJsdomShims = installJsdomShims();
  const originalRewindSession = daemonFacade.rewindSession;
  // 回退会走真实 IPC：基准里换成确定性的空结果，只保留 store 侧的发布行为。
  daemonFacade.rewindSession = (async () => ({})) as typeof daemonFacade.rewindSession;

  let mounted: MountedTree | null = null;
  const previousActEnvironment = readActEnvironment();
  setActEnvironment(true);

  try {
    // 上一次运行可能还有落在外面的补提交：先排空，让每次运行的起点相同。
    await drainPendingWork();
    primeSessionStore(sessionId);
    primeAgentStore(sessionId, events);
    resetSmoothness();
    usePerfStore.getState().reset();

    mounted = mountThread(sessionId, () => {
      commits.total += 1;
    });
    const container = mounted.container;

    const mount: LongSessionMountCounters = {
      componentCommits: commits.total,
      messageRows: countMessageRows(container),
      domNodes: container.querySelectorAll('*').length,
      longThreadAttribute: hasLongThreadAttribute(container),
    };

    // 挂载时的历史补全钉底会排两帧；先结算掉，别把它们算进后续步骤。
    clock.settle();

    const context: StepContext = { sessionId, container, clock, commits };
    const rewind = await runRewindStep(context, turnCount - 1);
    const stream = runStreamStep(context, { seed, frameCount: streamFrameCount });
    const nav = runNavStep(context, scrollCycles);

    const observations: LongSessionBenchmarkObservations = {
      streamClockSpanMs: streamFrameCount * FRAME_MS,
      visibleUpdateIntervalP50Ms: stream.intervalP50Ms,
      visibleUpdateIntervalP95Ms: stream.intervalP95Ms,
      wallClockMs: Date.now() - wallClockStartedAt,
    };

    return {
      counters: {
        scale: {
          sessionId,
          turnCount,
          eventCount,
          longSessionEventThreshold: LONG_SESSION_EVENT_THRESHOLD,
          isAboveThreshold: eventCount > LONG_SESSION_EVENT_THRESHOLD,
        },
        mount,
        rewind,
        stream: stream.counters,
        nav,
      },
      observations,
      observers: {
        storeGenerations: true,
        layoutReads: true,
        frameClock: true,
        perfStoreIpc: true,
      },
    };
  } finally {
    // 卸载也要在 act 环境里跑：撤标记必须等到所有 act 都结束之后。
    mounted?.unmount();
    // 卸载后可能还有补提交要落地：排空它们，别让它们算进下一次运行。
    await drainPendingWork();
    setActEnvironment(previousActEnvironment);
    resetSmoothness();
    usePerfStore.getState().reset();
    daemonFacade.rewindSession = originalRewindSession;
    restoreJsdomShims();
    clock.uninstall();
  }
}

/**
 * 短会话基线：低于长会话阈值时的对照。
 *
 * 它**不装任何观察者**（不记 store 发布代、不装几何读取计数器、不接管帧钟、不写
 * perfStore），也**不产出基准读数** —— 短会话下这些度量本身没有意义，装上去只会让
 * 「短会话行为与现状一致」这条断言失去内容。返回的只有一次无仪表挂载的事实。
 */
export function inspectShortSessionBaseline(
  turnCount: number = SHORT_SESSION_TURN_COUNT,
): ShortSessionBaseline {
  const sessionId = LONG_SESSION_ID;
  const events = buildLongSessionEvents(turnCount);
  const commits = { total: 0 };

  return withActEnvironment(() => {
    primeSessionStore(sessionId);
    primeAgentStore(sessionId, events);
    const restoreJsdomShims = installJsdomShims();

    const mounted = mountThread(sessionId, () => {
      commits.total += 1;
    });

    try {
      return {
        turnCount,
        eventCount: longSessionEventCount(turnCount),
        readings: null,
        observers: { ...NO_OBSERVERS },
        messageRows: countMessageRows(mounted.container),
        domNodes: mounted.container.querySelectorAll('*').length,
        longThreadAttribute: hasLongThreadAttribute(mounted.container),
        mountComponentCommits: commits.total,
      };
    } finally {
      mounted.unmount();
      restoreJsdomShims();
    }
  });
}
