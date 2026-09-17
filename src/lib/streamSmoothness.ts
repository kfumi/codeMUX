/**
 * 流式平滑度度量 —— 补上性能浮层里**唯一缺失、而正是用户抱怨的那个量**。
 *
 * 现有浮层只有 FPS、内存、WS 帧速率、长任务/秒。这些都不足以刻画"手感"：
 * Paseo 的对照实测给出了反例 —— 关闭分帧绘制时**总字符数完全相同**，但
 * 可见更新间隔 p95 从 17ms 恶化到 383ms。FPS 高不代表流式看起来顺。
 *
 * ## 口径（三件事不能省）
 *
 * 1. **变异系数与 p95 间隔必须同时看**：官方原话是"一个完全停顿的流是完美平滑的"。
 * 2. 因此还需要 **更新次数/秒** —— 它把"完全停顿"直接暴露出来（CV 会是 0）。
 * 3. 统计只针对**可见更新**：一次提交里文字真的变了才算一次。
 *    早期版本按"每个 rAF 帧"统计，在提交被节流之后会把大量"本就没打算更新"的
 *    帧记为停帧，变异系数被系统性夸大 —— 那是度量口径错误，不是真实抖动。
 *
 * ## 为什么不用 DOM 采样
 *
 * Paseo 从 DOM 累加所有 `assistant-message` 元素总长度（并记录了"只采尾部会把
 * 消息交接读成重置"的坑）。本项目渲染层没有等价的稳定公共选择器，因此改为
 * **在分帧绘制出口直接计数** —— 每一帧实际提交了多少字符，由绘制层自己上报。
 * 这比 DOM 采样更精确（不受 memo、虚拟化、交接影响）；代价是它只覆盖流式气泡
 * 本身，不含"内容块提交时整段出现"的那一次跳变。后者是消息边界的一次性事件，
 * 不属于连续流式的手感范畴。
 */

/** 度量窗口，与浮层的 1s 采样同频。 */
const WINDOW_MS = 1000;

/**
 * 窗口内的缓冲上限。
 *
 * 浮层只在 DEV 挂载；如果没有它，这些数组会以最多 60 条/秒的速度无限增长
 * （每分钟 3600 条）。到达上限后丢弃最旧的样本，读数仍然有效。
 */
const MAX_SAMPLES = 2048;

let frameCount = 0;
/** 每次"可见更新"实际提交的字符数（不含 0）。 */
let updateChars: number[] = [];
/** 相邻两次可见更新的间隔 ms。 */
let updateIntervals: number[] = [];
// 哨兵必须是 null 而不是 0 —— 时间戳为 0 是合法值，用 0 当"未开始"会把窗口起
// 点错写到第二次采样上（曾因此让 updatesPerSecond 在毫秒级时间戳下偏大 4%）。
let windowStartedAt: number | null = null;
let lastUpdateAt: number | null = null;

/**
 * 变异系数 = 标准差 / 均值。均值为 0（整窗没有任何推进）时返回 0 ——
 * 这种情况由 `updatesPerSecond === 0` 表达，不能靠变异系数识别。
 */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  const mean = sum / values.length;
  if (mean <= 0) {
    return 0;
  }
  let squared = 0;
  for (const value of values) {
    const diff = value - mean;
    squared += diff * diff;
  }
  const stdDev = Math.sqrt(squared / values.length);
  return stdDev / mean;
}

/** 最近秩法百分位。空数组返回 0。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

function pushCapped(target: number[], value: number): void {
  target.push(value);
  if (target.length > MAX_SAMPLES) {
    target.splice(0, target.length - MAX_SAMPLES);
  }
}

export interface SmoothnessSnapshot {
  /** 窗口内采到的帧数。太少说明样本不足，读数不可信。 */
  sampledFrames: number;
  /** 可见更新次数。 */
  visibleUpdates: number;
  /** 更新次数/秒。为 0 且流仍在跑 ⇒ 流停住了。 */
  updatesPerSecond: number;
  /** 每次可见更新提交的字符数的变异系数。越低越均匀。 */
  charsPerUpdateCv: number;
  /** 可见更新间隔（ms）。 */
  updateIntervalP50: number;
  updateIntervalP95: number;
  charsPerSecond: number;
}

const EMPTY_SNAPSHOT: SmoothnessSnapshot = {
  sampledFrames: 0,
  visibleUpdates: 0,
  updatesPerSecond: 0,
  charsPerUpdateCv: 0,
  updateIntervalP50: 0,
  updateIntervalP95: 0,
  charsPerSecond: 0,
};

/**
 * 绘制层每帧调用一次。`charsAdded` 是**本次提交真正画上去**的字符数，
 * 没有提交（被节流跳过、或已追平）时传 0。
 *
 * 由 `useStreamingTextReveal` 在帧回调里调用，开销是一次计数加最多两次 push。
 */
export function recordRevealFrame(charsAdded: number, now: number): void {
  if (windowStartedAt === null) {
    windowStartedAt = now;
  }
  frameCount += 1;
  if (charsAdded <= 0) {
    return;
  }
  if (lastUpdateAt !== null) {
    pushCapped(updateIntervals, now - lastUpdateAt);
  }
  lastUpdateAt = now;
  pushCapped(updateChars, charsAdded);
}

/** 读取并重置窗口。浮层的 1s tick 调用。 */
export function readAndResetSmoothness(now: number): SmoothnessSnapshot {
  if (frameCount === 0) {
    return EMPTY_SNAPSHOT;
  }

  const chars = updateChars;
  const intervals = updateIntervals;
  const elapsedMs = Math.max(1, now - (windowStartedAt ?? now));
  const totalChars = chars.reduce((sum, value) => sum + value, 0);

  const snapshot: SmoothnessSnapshot = {
    sampledFrames: frameCount,
    visibleUpdates: chars.length,
    updatesPerSecond: (chars.length * 1000) / elapsedMs,
    charsPerUpdateCv: coefficientOfVariation(chars),
    updateIntervalP50: percentile(intervals, 50),
    updateIntervalP95: percentile(intervals, 95),
    charsPerSecond: (totalChars * 1000) / elapsedMs,
  };

  frameCount = 0;
  updateChars = [];
  updateIntervals = [];
  windowStartedAt = null;
  lastUpdateAt = null;
  return snapshot;
}

/** 仅供测试与"停止流式"时复位。 */
export function resetSmoothness(): void {
  frameCount = 0;
  updateChars = [];
  updateIntervals = [];
  windowStartedAt = null;
  lastUpdateAt = null;
}

export const SMOOTHNESS_WINDOW_MS = WINDOW_MS;
