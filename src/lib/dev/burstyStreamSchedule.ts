/**
 * 种子化的 bursty 流式事件源 —— 让"复现 → 修复 → 复测"可比。
 *
 * 动机来自 Paseo 的做法：它的 mock provider 有一个 `bursty-stream` 模型，产生
 * 不均匀的 token 串与空闲间隔，**突发大小来自种子生成器，所以同一次运行可精确
 * 复现**。没有这个，就只能拿真实会话碰运气，改动前后的数字不可比。
 *
 * 本模块是**纯函数**：给定种子，产出确定的 `{ atMs, text }` 序列。驱动交给调用方
 * （测试用假定时器，开发期用真实 setTimeout），因此调度逻辑可单测。
 */

/** mulberry32：小而确定的 PRNG，同一种子必得同一序列。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BurstyChunk {
  /** 相对流开始时刻的偏移。 */
  atMs: number;
  text: string;
}

export interface BurstyStreamOptions {
  seed: number;
  /** 总时长。 */
  totalMs?: number;
  /** 两批之间的基准间隔。 */
  chunkIntervalMs?: number;
  /** 出现停顿（模拟模型思考 / 网络抖动）的概率。 */
  idleProbability?: number;
  /** 一次突发的最小 / 最大字符数。 */
  burstMinChars?: number;
  burstMaxChars?: number;
  /** 生成文本用的字素表。 */
  alphabet?: string;
}

const DEFAULT_ALPHABET = 'the quick brown fox jumps over the lazy dog 0123456789 ';

/**
 * 产出一个突发的字符流。
 *
 * 设计目标是复刻真实的"不均匀"：多数批次很小，偶尔出现比基准大一到两个数量级的
 * 突发，并夹杂几百毫秒的完全空闲 —— 这正是让"到达即绘制"看起来一跳一跳的形态。
 */
export function createBurstyStreamSchedule(options: BurstyStreamOptions): BurstyChunk[] {
  const {
    seed,
    totalMs = 8_000,
    chunkIntervalMs = 50,
    idleProbability = 0.18,
    burstMinChars = 4,
    burstMaxChars = 900,
    alphabet = DEFAULT_ALPHABET,
  } = options;

  const random = createRandom(seed);
  const chunks: BurstyChunk[] = [];
  let atMs = 0;

  while (atMs < totalMs) {
    // 批次大小：多数小时段落在小值，少数突发拉到很大 —— 用三次方偏置而非均匀分布，
    // 因为均匀分布产生的"不均匀度"不足以复现真实拥堵。
    const bias = random() ** 3;
    const size = Math.round(burstMinChars + bias * (burstMaxChars - burstMinChars));
    let text = '';
    for (let index = 0; index < size; index += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    chunks.push({ atMs, text });

    // 空闲：命中则跳过若干个基准间隔。
    if (random() < idleProbability) {
      atMs += chunkIntervalMs * (3 + Math.floor(random() * 8));
    } else {
      atMs += chunkIntervalMs;
    }
  }

  return chunks;
}

export interface BurstyPumpOptions {
  /** 时间缩放。`2` 表示用两倍速度回放。 */
  speed?: number;
  /** 可选：覆盖排程函数，测试用假定时器。 */
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  now?: () => number;
}

/**
 * 按调度把文本推给 `sink`。返回一个取消函数。
 *
 * 用单个自纠偏定时器而不是为每批排一个定时器：批量可能有上千个，排程开销会盖过
 * 被测对象本身，反而污染度量。
 */
export function pumpBurstySchedule(
  schedule: readonly BurstyChunk[],
  sink: (text: string) => void,
  options: BurstyPumpOptions = {},
): () => void {
  const {
    speed = 1,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimer = (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    now = () => performance.now(),
  } = options;

  let cursor = 0;
  let handle: number | null = null;
  let cancelled = false;
  const startedAt = now();

  const step = () => {
    if (cancelled) {
      return;
    }
    const elapsed = (now() - startedAt) * speed;

    while (cursor < schedule.length && schedule[cursor].atMs <= elapsed) {
      sink(schedule[cursor].text);
      cursor += 1;
    }

    if (cursor >= schedule.length) {
      handle = null;
      return;
    }

    const waitMs = Math.max(1, (schedule[cursor].atMs - elapsed) / speed);
    handle = setTimer(step, waitMs);
  };

  handle = setTimer(step, Math.max(1, schedule[0]?.atMs ?? 1));

  return () => {
    cancelled = true;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };
}
