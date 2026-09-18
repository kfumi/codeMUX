/**
 * 尾部挂载窗口 —— 纯函数模型（工单 03「尾部挂载窗口」）。
 *
 * 长会话不再把整条历史留在渲染树里：只保留**尾部连续一段**（单位：轮）。被扣掉的
 * 历史仍然在 store 里 —— 搜索、导航、回退都还能到达 —— 只是不再占用渲染资源。
 * 本模块是有界性的唯一权威：常量集中命名（spec「Implementation Decisions」第 28 条），
 * 解析与增长都是纯函数，CI 安全。
 *
 * 单位换算：spec 说的行数（首帧 ~15 行、稳态 ~60 行、触顶增长 ~40 行）按「本项目一轮
 * 约等于 2 个消息行（一条用户行 + 一条助手行）」映射成轮：8 / 30 / 20。真实会话一轮
 * 的消息行数随工具调用数量浮动，因此这些常量是**预算**而不是精确行数 —— 挂载行数的
 * 实际上界由「轮数 × 每轮消息行数」天然给出，不在此处估算（spec 明令禁止按未挂载
 * 条数估算占位高度，同理也不在这里估算行数）。
 */

/** 首帧提交挂载的轮数（≈ spec 的 15 行）。 */
export const THREAD_WINDOW_INITIAL_COMMIT_TURNS = 8;

/** 稳态窗口的轮数（≈ spec 的 60 行）。稳态扩张发生在首帧之后，不在首帧付。 */
export const THREAD_WINDOW_STEADY_TURNS = 30;

/** 每次触顶增长的轮数（≈ spec 的 40 行）。 */
export const THREAD_WINDOW_GROWTH_STEP_TURNS = 20;

/**
 * 窗口逻辑的事件数阈值：与生产里判定长会话的 `[data-long-thread]` 阈值同源
 * （此前是 `CodeMuxThread.tsx` 里的 `LONG_THREAD_EVENT_THRESHOLD = 120`）。
 * 低于阈值时会话逐字节保持现状：不切片、不挂 spacer、不开任何窗口逻辑。
 */
export const THREAD_WINDOW_EVENT_THRESHOLD = 120;

/** 滚动触顶增长的近顶阈值（px）：`scrollTop` 低于它就认为用户读到了窗口顶部。 */
export const THREAD_WINDOW_GROW_TRIGGER_TOP_PX = 120;

export interface ThreadWindowResolution {
  /** 本帧挂载的轮数（尾部连续一段）。 */
  mountedTurns: number;
  /** 挂载窗口之上被隐藏的轮数（0 = 没有被扣掉的历史，不显示「更早历史」标记）。 */
  hiddenAboveTurns: number;
  /** 是否处于有界（被裁剪）状态。 */
  bounded: boolean;
}

export interface ReduceThreadWindowInput {
  /** 已加载历史的总轮数。 */
  totalTurns: number;
  /** 当前窗口预算（轮）。首帧提交时它被首帧常量取代（见 `initialCommit`）。 */
  windowSize: number;
  /**
   * 是否处于首帧提交。首帧门控必须在 render 期派生：调用方用「store 里有没有该会话
   * 的窗口预算」直接算出它，不由 layout effect 翻转 —— 否则会出现「先挂载全量、再
   * 丢弃重建」的三次提交，长会话反而白付一次全量 DOM。稳态窗口的扩张发生在首帧之后。
   */
  initialCommit: boolean;
}

/**
 * 解析「本帧挂载多少轮、上方隐藏多少轮、是否被裁剪」。
 *
 * 模型无状态：按会话重置由调用方保证（store 按会话记录预算，历史重新装载时清掉），
 * 夹取到实际已加载轮数在这里完成 —— 上一会话增长的预算不会漏进新会话的首帧。
 */
export function reduceThreadWindow(input: ReduceThreadWindowInput): ThreadWindowResolution {
  const totalTurns = Math.max(0, Math.trunc(input.totalTurns));
  const storedSize = Math.max(0, Math.trunc(input.windowSize));
  const requested = input.initialCommit
    ? THREAD_WINDOW_INITIAL_COMMIT_TURNS
    : Math.max(THREAD_WINDOW_INITIAL_COMMIT_TURNS, storedSize);
  const mountedTurns = Math.min(requested, totalTurns);
  const hiddenAboveTurns = totalTurns - mountedTurns;
  return { mountedTurns, hiddenAboveTurns, bounded: hiddenAboveTurns > 0 };
}

/**
 * 触顶增长：把窗口预算涨一格，夹取到实际已加载轮数。
 *
 * 首帧预算尚未到稳态时，第一步直接到稳态（+20 的步长只在稳态之后生效 —— 从 8 涨到
 * 28 会落在稳态之下，与「稳态扩张在首帧之后」的语义打架）。已覆盖全部历史时不再变化。
 */
export function growThreadWindow(windowSize: number, totalTurns: number): number {
  const total = Math.max(0, Math.trunc(totalTurns));
  const current = Math.max(THREAD_WINDOW_INITIAL_COMMIT_TURNS, Math.trunc(windowSize));
  const next = current < THREAD_WINDOW_STEADY_TURNS
    ? THREAD_WINDOW_STEADY_TURNS
    : current + THREAD_WINDOW_GROWTH_STEP_TURNS;
  return Math.min(next, Math.max(current, total));
}

/**
 * 「按事件下标揭示」：一步算出包含第 `turnIndex` 轮（0 起）所需的窗口预算。
 *
 * 挂载的是尾部连续一段，因此要让第 `turnIndex` 轮可见，预算至少是
 * `totalTurns - turnIndex`。搜索/跳转在目标轮可能落在窗口外时先调这个，再滚动。
 */
export function revealThreadWindow(
  windowSize: number,
  turnIndex: number,
  totalTurns: number,
): number {
  const total = Math.max(0, Math.trunc(totalTurns));
  if (total === 0) {
    return Math.max(THREAD_WINDOW_INITIAL_COMMIT_TURNS, Math.trunc(windowSize));
  }
  const clampedTurnIndex = Math.min(Math.max(0, Math.trunc(turnIndex)), total - 1);
  const neededTurns = total - clampedTurnIndex;
  const current = Math.max(THREAD_WINDOW_INITIAL_COMMIT_TURNS, Math.trunc(windowSize));
  return Math.min(Math.max(current, neededTurns), Math.max(current, total));
}

/**
 * 首帧占位 spacer 的渲染判定（纯函数，供 render 期派生）。
 *
 * spacer 只服务「有界后的底部可达」：固定高度的 CSS 类（min-height: 100vh 量级），
 * 绝不按未挂载条数估算 —— 按条数估算的占位与它替代的真实行不匹配，展开时会把可见
 * 文本推走，表现为一次页面翻转式跳变。只在首帧有界提交时存在。
 */
export function shouldRenderFirstFrameSpacer(input: {
  bounded: boolean;
  windowSize: number;
}): boolean {
  return input.bounded
    && Math.max(0, Math.trunc(input.windowSize)) <= THREAD_WINDOW_INITIAL_COMMIT_TURNS;
}

/**
 * 尾部 `mountedTurns` 个轮里第一个轮的起始事件下标（绝对下标，即切片点）。
 *
 * 轮的边界天然保证 tool_use/tool_result 不被拆开，所以从轮边界切片是安全的；
 * 轮上挂在首个真实事件之前的 prelude 元数据（system/raw/ready）也属于该轮，
 * 用 `eventIndices[0]` 取起点可以把它们一起带上。
 */
export function resolveMountedTurnStartEventIndex(
  turns: ReadonlyArray<{ eventIndices: ReadonlyArray<number> }>,
  mountedTurns: number,
): number {
  if (turns.length === 0 || mountedTurns <= 0) {
    return 0;
  }
  const firstMounted = Math.max(0, turns.length - Math.trunc(mountedTurns));
  return turns[firstMounted]?.eventIndices[0] ?? 0;
}

/** 找出包含 `eventIndex` 的轮下标（turns 按事件顺序排列；找不到归属时返回最后一轮）。 */
export function findTurnIndexByEventIndex(
  turns: ReadonlyArray<{ eventIndices: ReadonlyArray<number> }>,
  eventIndex: number,
): number {
  let owner = Math.max(0, turns.length - 1);
  for (let index = 0; index < turns.length; index += 1) {
    const start = turns[index]?.eventIndices[0];
    if (start == null || start > eventIndex) {
      break;
    }
    owner = index;
  }
  return owner;
}
